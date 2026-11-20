import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});

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
  it('keeps the tree in the fixed list pane of the frame, with nothing to drag', async () => {
    const fixture = await open(make());
    const frame = root(fixture).querySelector('[data-testid="changes-list-pane"]');

    expect(root(fixture).querySelector('[role=separator]')).toBeNull();
    expect(frame?.contains(root(fixture).querySelector('[data-testid="files-tree"]'))).toBe(true);
    expect(frame?.className).toContain('@3xl:w-[340px]');
  });

  it('shows the open file path, its line count and a way to copy the path', async () => {
    const served = make();
    served.files.set('README.md', { _tag: 'Text', content: 'one\ntwo\n', size: 8 });
    const fixture = await open(served);

    rowOf(fixture, 'README.md').click();
    await settle(fixture);

    expect(text(fixture, 'file-path')).toContain('README.md');
    expect(text(fixture, 'file-lines')).toBe('3 lines');
    expect(root(fixture).querySelector('[data-testid="file-copy-path"]')).not.toBeNull();
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

  it('renders the latest successful worker response with both theme colors', async () => {
    const messages: { id: number; content: string; lang: string }[] = [];
    class TestWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(message: { id: number; content: string; lang: string }): void {
        messages.push(message);
      }
      terminate(): void {}
    }
    const worker = new TestWorker();
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          return worker;
        }
      },
    );
    const served = make();
    served.listings.set('', listing(file('first.ts'), file('second.ts')));
    served.files.set('first.ts', { _tag: 'Text', content: 'old', size: 3 });
    served.files.set('second.ts', { _tag: 'Text', content: 'const x', size: 7 });
    const fixture = await open(served);
    rowOf(fixture, 'first.ts').click();
    await settle(fixture);
    rowOf(fixture, 'second.ts').click();
    await settle(fixture);
    expect(messages.map(({ content, lang }) => ({ content, lang }))).toEqual([
      { content: 'old', lang: 'typescript' },
      { content: 'const x', lang: 'typescript' },
    ]);
    worker.onmessage?.(
      new MessageEvent('message', {
        data: { id: messages[0]?.id, lines: [[{ content: 'stale' }]] },
      }),
    );
    fixture.detectChanges();
    expect(text(fixture, 'file-source')).toBe('const x');
    worker.onmessage?.(
      new MessageEvent('message', {
        data: {
          id: messages[1]?.id,
          lines: [
            [
              { content: 'const', light: '#123456', dark: '#abcdef' },
              { content: ' x', light: undefined, dark: undefined },
            ],
          ],
        },
      }),
    );
    fixture.detectChanges();
    const token = root(fixture).querySelector<HTMLElement>('.file-token');
    expect(text(fixture, 'file-source')).toBe('const x');
    expect(token?.style.getPropertyValue('--token-light')).toBe('#123456');
    expect(token?.style.getPropertyValue('--token-dark')).toBe('#abcdef');
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
