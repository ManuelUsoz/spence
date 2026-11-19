import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { SettingsRpcs } from '../../../shared/settings/settings.rpc';
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
  width: number;
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
  width: 320,
});

const settings = (filesTreeWidth: number) => ({
  language: 'system' as const,
  theme: 'system' as const,
  notifications: true,
  projectOrder: { by: 'lastUsed' as const, direction: 'desc' as const },
  defaultPermissionMode: 'auto' as const,
  defaultAgent: 'claude',
  autoArchiveDays: null,
  crossProjectAccess: [],
  agents: {},
  filesTreeWidth,
});

const serve = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
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
      SettingsRpcs.toLayer({
        'Settings.get': () => Effect.succeed(settings(served.width)),
        'Settings.update': ({ patch }) => {
          served.width = patch.filesTreeWidth ?? served.width;
          return Effect.succeed(settings(served.width));
        },
      }),
    ),
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
  it('shows decorative icons for files and the state of folders', async () => {
    const fixture = await open(make());
    const icon = (name: string) => rowOf(fixture, name).querySelector('[data-file-icon]');
    expect(icon('src')?.getAttribute('data-file-icon')).toBe('folder');
    expect(icon('README.md')?.getAttribute('data-file-icon')).toBe('readme');
    expect(icon('README.md')?.getAttribute('aria-hidden')).toBe('true');
    rowOf(fixture, 'src').click();
    await settle(fixture);
    expect(icon('src')?.getAttribute('data-file-icon')).toBe('folder-open');
    expect(icon('main.ts')?.getAttribute('data-file-icon')).toBe('typescript');
  });
  it('keeps keyboard resizing within its limits', async () => {
    const fixture = await open(make());
    const separator = root(fixture).querySelector<HTMLElement>('[role=separator]');
    separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await settle(fixture);
    expect(separator?.getAttribute('aria-valuenow')).toBe('160');
    separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await settle(fixture);
    expect(separator?.getAttribute('aria-valuenow')).toBe('480');
  });
  it('remembers keyboard resizing for the next visit', async () => {
    const served = make();
    const fixture = await open(served);
    const separator = root(fixture).querySelector<HTMLElement>('[role=separator]');
    separator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await settle(fixture);
    fixture.destroy();
    const next = TestBed.createComponent(FilesTab);
    next.componentRef.setInput('sessionId', sessionId);
    next.detectChanges();
    await settle(next);
    expect(root(next).querySelector('[role=separator]')?.getAttribute('aria-valuenow')).toBe('330');
  });
  it('restores the tree width from Settings', async () => {
    const fixture = await open(make());
    expect(root(fixture).querySelector('[role=separator]')?.getAttribute('aria-valuenow')).toBe(
      '320',
    );
  });
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
    expect(root(fixture).querySelector('app-markdown-view h1')?.textContent).toBe('Spence');
    expect(root(fixture).querySelector('[data-testid="line-numbers"]')).toBeNull();
  });

  it('keeps the source choice when navigating files and hides the toggle for other files', async () => {
    const served = make();
    served.listings.set('', listing(file('README.md'), file('other.MARKDOWN'), file('notes.txt')));
    served.files.set('other.MARKDOWN', { _tag: 'Text', content: '# Other', size: 7 });
    served.files.set('notes.txt', { _tag: 'Text', content: 'plain', size: 5 });
    const fixture = await open(served);
    rowOf(fixture, 'README.md').click();
    await settle(fixture);
    const source = Array.from(root(fixture).querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Source',
    );
    source?.click();
    fixture.detectChanges();
    expect(text(fixture, 'file-source')).toBe('# Spence\n');
    expect(text(fixture, 'line-numbers')).toBe('1\n2\n');
    expect(
      root(fixture)
        .querySelector('[data-testid="line-numbers"]')
        ?.classList.contains('select-none'),
    ).toBe(true);
    rowOf(fixture, 'notes.txt').click();
    await settle(fixture);
    expect(root(fixture).querySelector('[aria-label="Markdown view"]')).toBeNull();
    expect(text(fixture, 'file-source')).toBe('plain');
    rowOf(fixture, 'other.MARKDOWN').click();
    await settle(fixture);
    expect(text(fixture, 'file-source')).toBe('# Other');
    const rendered = Array.from(root(fixture).querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Rendered',
    );
    rendered?.click();
    fixture.detectChanges();
    expect(root(fixture).querySelector('app-markdown-view h1')?.textContent).toBe('Other');
  });

  it('keeps unknown and large files readable with line numbers', async () => {
    const served = make();
    served.listings.set('', listing(file('notes.unknown'), file('large.ts')));
    served.files.set('notes.unknown', { _tag: 'Text', content: 'first\nsecond', size: 12 });
    served.files.set('large.ts', {
      _tag: 'Text',
      content: 'line\n'.repeat(2000) + 'last',
      size: 10004,
    });
    const fixture = await open(served);
    rowOf(fixture, 'notes.unknown').click();
    await settle(fixture);
    expect(text(fixture, 'file-source')).toBe('first\nsecond');
    expect(text(fixture, 'line-numbers')).toBe('1\n2\n');
    expect(root(fixture).querySelector('.file-token')).toBeNull();
    rowOf(fixture, 'large.ts').click();
    await settle(fixture);
    expect(text(fixture, 'file-source')).toContain('last');
    expect(root(fixture).querySelectorAll('[data-testid="line-numbers"] span')).toHaveLength(2001);
    expect(root(fixture).querySelector('.file-token')).toBeNull();
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

  it('reads the folder and the open file again when the page asks for a fresh read', async () => {
    const served = make();
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
    });
    const fixture = TestBed.createComponent(FilesTab);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();
    await settle(fixture);
    rowOf(fixture, 'README.md').click();
    await settle(fixture);
    served.files.set('README.md', { _tag: 'Text', content: '# Changed\n', size: 10 });

    fixture.componentRef.setInput('reload', 1);
    fixture.detectChanges();
    await settle(fixture);

    expect(root(fixture).querySelector('app-markdown-view h1')?.textContent).toBe('Changed');
  });
});
