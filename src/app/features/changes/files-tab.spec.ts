import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilesRpcs,
  type FolderEntry,
  type FolderListing,
  type TextFile,
} from '../../../shared/files/files.rpc';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { FilesTab } from './files-tab';

const sessionId = SessionId.make('session-1');

const dir = (name: string, ignored = false): FolderEntry => ({ name, kind: 'Dir', ignored });
const file = (name: string, ignored = false): FolderEntry => ({ name, kind: 'File', ignored });

const listing = (...entries: FolderEntry[]): FolderListing => ({
  _tag: 'Listing',
  entries,
  truncated: false,
});

interface Served {
  listings: Map<string, FolderListing>;
  files: Map<string, TextFile>;
  listAsks: string[];
  readAsks: string[];
}

const make = (): Served => ({
  listings: new Map([
    ['', listing(dir('src'), dir('dist', true), file('README.md'), file('debug.log', true))],
    ['src', listing(file('main.ts'))],
  ]),
  files: new Map<string, TextFile>([
    ['README.md', { _tag: 'Text', content: '# Spence\n', size: 9 }],
    ['src/main.ts', { _tag: 'NoPreview', reason: 'Binary' }],
  ]),
  listAsks: [],
  readAsks: [],
});

const serve = (served: Served) =>
  makeDesktopTestLayer(
    FilesRpcs.toLayer({
      'Files.list': ({ path }) => {
        served.listAsks.push(path);
        return Effect.succeed(served.listings.get(path) ?? { _tag: 'Missing', detail: 'gone' });
      },
      'Files.read': ({ path }) => {
        served.readAsks.push(path);
        return Effect.succeed(
          served.files.get(path) ?? { _tag: 'NoPreview', reason: 'Missing' as const },
        );
      },
    }),
  );

const settle = async (fixture: ComponentFixture<FilesTab>): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
};

const open = async (served: Served): Promise<ComponentFixture<FilesTab>> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
  });
  const fixture = TestBed.createComponent(FilesTab);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
};

const root = (fixture: ComponentFixture<FilesTab>): HTMLElement =>
  fixture.nativeElement as HTMLElement;

const names = (fixture: ComponentFixture<FilesTab>): string[] =>
  Array.from(root(fixture).querySelectorAll('[data-testid="file-row"]')).map(
    (row) => row.querySelector('.font-mono')?.textContent?.trim() ?? '',
  );

const rowOf = (fixture: ComponentFixture<FilesTab>, name: string): HTMLButtonElement =>
  Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('[data-testid="file-row"]')).find(
    (row) => row.querySelector('.font-mono')?.textContent?.trim() === name,
  )!;

const text = (fixture: ComponentFixture<FilesTab>, testId: string): string =>
  root(fixture).querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';

afterEach(() => TestBed.resetTestingModule());

describe('FilesTab', () => {
  it('lists the top folder without what .gitignore ignores, and shows it on request', async () => {
    const fixture = await open(make());
    expect(names(fixture)).toEqual(['src', 'README.md']);

    const toggle = root(fixture).querySelector<HTMLInputElement>(
      '[data-testid="files-show-ignored"]',
    )!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(names(fixture)).toEqual(['src', 'dist', 'README.md', 'debug.log']);
  });

  it('reads a folder only when it is opened, and hides its files when it is closed', async () => {
    const served = make();
    const fixture = await open(served);
    expect(served.listAsks).toEqual(['']);

    rowOf(fixture, 'src').click();
    await settle(fixture);
    expect(served.listAsks).toEqual(['', 'src']);
    expect(names(fixture)).toEqual(['src', 'main.ts', 'README.md']);

    rowOf(fixture, 'src').click();
    await settle(fixture);
    expect(names(fixture)).toEqual(['src', 'README.md']);
  });

  it('shows the text of the chosen file', async () => {
    const served = make();
    const fixture = await open(served);

    rowOf(fixture, 'README.md').click();
    await settle(fixture);

    expect(served.readAsks).toEqual(['README.md']);
    expect(text(fixture, 'file-content')).toBe('# Spence\n');
  });

  it('says why a file has no text to show', async () => {
    const fixture = await open(make());
    rowOf(fixture, 'src').click();
    await settle(fixture);

    rowOf(fixture, 'main.ts').click();
    await settle(fixture);

    expect(text(fixture, 'file-nopreview')).toContain('This file is binary');
  });

  it('says so when the Session folder cannot be listed', async () => {
    const served = make();
    served.listings.set('', { _tag: 'Missing', detail: 'gone' });

    const fixture = await open(served);

    expect(text(fixture, 'files-problem')).toContain('folder was not found');
    expect(names(fixture)).toEqual([]);
  });

  it('reads the folder and the open file again when a running Turn ends', async () => {
    const served = make();
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
    });
    const fixture = TestBed.createComponent(FilesTab);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    await settle(fixture);
    rowOf(fixture, 'README.md').click();
    await settle(fixture);
    served.files.set('README.md', { _tag: 'Text', content: '# Changed\n', size: 10 });

    fixture.componentRef.setInput('running', false);
    fixture.detectChanges();
    await settle(fixture);

    expect(text(fixture, 'file-content')).toBe('# Changed\n');
  });
});
