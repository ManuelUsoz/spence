import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMarkdownCache, markdownBlocks, parseMarkdown, MarkdownView } from '@ui/markdown';
import { isAllowedExternalUrl } from '../../../shared/links/link-policy';

@Component({
  selector: 'app-markdown-host',
  imports: [MarkdownView],
  template: `<app-markdown-view
    [text]="text()"
    [settled]="settled()"
    [isAllowedLink]="isAllowedExternalUrl"
    (openLink)="opened.push($event)"
  />`,
})
class Host {
  readonly isAllowedExternalUrl = isAllowedExternalUrl;
  readonly text = signal('');
  readonly settled = signal(false);
  readonly opened: Array<string> = [];
}

const render = (text: string, settled = true): { fixture: ComponentFixture<Host>; host: Host } => {
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.text.set(text);
  host.settled.set(settled);
  fixture.detectChanges();
  return { fixture, host };
};

const root = (fixture: ComponentFixture<Host>): HTMLElement => fixture.nativeElement as HTMLElement;

afterEach(() => {
  clearMarkdownCache();
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('parseMarkdown', () => {
  it('keeps standard nesting for headings, emphasis, lists, tables, quotes and code', () => {
    const tree = parseMarkdown(`# Title

**bold** and *italic* and ~~gone~~ with \`inline\`.

> quoted

1. first
   - nested
2. second

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`ts
const x = 1;
\`\`\``);
    expect(tree.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'blockquote',
      'list',
      'table',
      'code',
    ]);
    const list = tree[3];
    expect(list?.type === 'list' && list.ordered).toBe(true);
    expect(list?.type === 'list' && list.items[0]?.children[1]?.type).toBe('list');
    const table = tree[4];
    expect(table?.type === 'table' && table.header.length).toBe(2);
    expect(table?.type === 'table' && table.rows[0]?.length).toBe(2);
    expect(tree[5]?.type === 'code' && tree[5].lang).toBe('ts');
  });

  it('parses incomplete streaming syntax without losing text', () => {
    const tree = parseMarkdown('A **bold');
    expect(tree[0]?.type).toBe('paragraph');
    expect(
      tree[0]?.type === 'paragraph' ? tree[0].children.map((child) => child.type) : [],
    ).toContain('text');
  });

  it('renders the same tree for any chunking once the text is whole', () => {
    const whole = '## Plan\n\n- one\n- two\n\n```js\nrun();\n```\n';
    const chunks = ['## Pl', 'an\n\n- one', '\n- two\n\n```j', 's\nrun();\n```', '\n'];
    let assembled = '';
    for (const chunk of chunks) assembled += chunk;
    expect(assembled).toBe(whole);
    expect(markdownBlocks(assembled, false)).toEqual(markdownBlocks(whole, true));
  });

  it('keeps raw HTML as literal text, including script-like content', () => {
    const tree = parseMarkdown('<b>Hello</b>\n\n<script>alert("x")</script>');
    const paragraph = tree[0];
    expect(paragraph?.type).toBe('paragraph');
    expect(
      paragraph?.type === 'paragraph'
        ? paragraph.children.filter((child) => child.type === 'html').map((child) => child.value)
        : [],
    ).toEqual(['<b>', '</b>']);
    expect(tree[1]?.type === 'html' && tree[1].value).toContain('alert');
  });
});

describe('MarkdownView', () => {
  it('renders the supported subset through static templates', () => {
    const { fixture } = render(`## Heading

**strong** *em* ~~gone~~ \`code\`

> quote

- one
- [x] done
- [ ] todo

| Left | Right |
| --- | ---: |
| a | b |

\`\`\`ts
const x = 1;
\`\`\``);
    const element = root(fixture);
    expect(element.querySelector('h2')?.textContent).toBe('Heading');
    expect(element.querySelector('strong')?.textContent).toBe('strong');
    expect(element.querySelector('em')?.textContent).toBe('em');
    expect(element.querySelector('del')?.textContent).toBe('gone');
    expect(element.querySelector('code')?.textContent).toBe('code');
    expect(element.querySelector('blockquote')?.textContent?.trim()).toBe('quote');
    expect(element.querySelectorAll('li')).toHaveLength(3);
    const tasks = [...element.querySelectorAll('input[type="checkbox"]')];
    expect(tasks.map((task) => (task as HTMLInputElement).checked)).toEqual([true, false]);
    expect(tasks.every((task) => (task as HTMLInputElement).disabled)).toBe(true);
    expect(element.querySelectorAll('thead th')).toHaveLength(2);
    expect(element.querySelectorAll('tbody td')).toHaveLength(2);
    expect(element.querySelector('[data-testid="markdown-code"]')?.textContent).toContain(
      'const x = 1;',
    );
    expect(element.querySelector('[data-testid="markdown-code"]')?.textContent).toContain('ts');
  });

  it('copies fenced code exactly, without fences or labels', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { fixture } = render('```ts\nconst x = 1;\n```');
    const copy = root(fixture).querySelector('[data-testid="markdown-copy"]') as HTMLButtonElement;
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
  });

  it('shows unknown and missing code languages as plain text metadata', () => {
    const { fixture } = render('```mystery\nraw\n```\n\n```\nplain\n```');
    const blocks = [...root(fixture).querySelectorAll('[data-testid="markdown-code"]')];
    expect(blocks[0]?.textContent).toContain('mystery');
    expect(blocks[1]?.textContent).toContain('Plain text');
    expect(blocks[1]?.querySelector('pre')?.textContent).toBe('plain');
  });

  it('shows inline and block HTML literally and never executes it', () => {
    const { fixture } = render('<b>Hello</b>\n\n<script>alert("x")</script>');
    const element = root(fixture);
    const inline = [...element.querySelectorAll('[data-testid="markdown-html-inline"]')].map(
      (node) => node.textContent,
    );
    expect(inline).toEqual(['<b>', '</b>']);
    expect(element.querySelector('[data-testid="markdown-html"]')?.textContent).toContain('alert');
    expect(element.querySelector('script')).toBeNull();
  });

  it('shows Markdown image alt text without an image request', () => {
    const { fixture } = render('![A diagram](https://example.com/a.png)');
    const alt = root(fixture).querySelector('[data-testid="markdown-image"]');
    expect(alt?.textContent).toBe('A diagram');
    expect(root(fixture).querySelector('img')).toBeNull();
  });

  it('routes only absolute HTTPS links without credentials, and never navigates on activation', () => {
    const { fixture, host } =
      render(`[good](https://example.com/docs) [plain](https://user:secret@example.com/x)

[relative](/settings) [fragment](#top) [mail](mailto:a@example.com)`);
    const element = root(fixture);
    const links = [...element.querySelectorAll('[data-testid="markdown-link"]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.com/docs']);
    expect(element.querySelectorAll('[data-testid="markdown-link-text"]')).toHaveLength(4);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    links[0]?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(host.opened).toEqual(['https://example.com/docs']);

    // Middle-click and modifier activation follow the same route, and still cannot navigate the app.
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    links[0]?.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    const modified = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    links[0]?.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(true);
    expect(host.opened).toHaveLength(3);
  });

  it('coalesces streamed parses and renders the final whole-message result', async () => {
    const { fixture, host } = render('Hel', false);
    host.text.set('Hello **wor');
    fixture.detectChanges();
    host.text.set('Hello **world**');
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    expect(root(fixture).querySelector('strong')?.textContent).toBe('world');

    host.settled.set(true);
    fixture.detectChanges();
    expect(root(fixture).querySelector('strong')?.textContent).toBe('world');
  });

  it('keeps a text selection inside the reply across streamed updates', async () => {
    const { fixture, host } = render('Hello world', false);
    await Promise.resolve();
    fixture.detectChanges();

    const paragraph = root(fixture).querySelector('p');
    const text = paragraph?.querySelector('span')?.firstChild;
    expect(text?.nodeType).toBe(Node.TEXT_NODE);
    const range = document.createRange();
    range.setStart(text as Node, 0);
    range.setEnd(text as Node, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe('Hello');

    host.text.set('Hello world, still streaming');
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    for (let index = 0; index < 5; index++) {
      host.text.set(`Hello world, still streaming ${index}`);
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
    }
    host.settled.set(true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(window.getSelection()?.toString()).toBe('Hello'));
  });
});
