import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../shared/sessions/sessions.rpc';
import { ComposerBridge, formatConsoleErrors, formatPickedElement } from './composer-bridge';

const s1 = SessionId.make('bridge-s1');
const s2 = SessionId.make('bridge-s2');

describe('ComposerBridge', () => {
  it('queues and consumes attachments per Session independently', () => {
    const bridge = TestBed.inject(ComposerBridge);

    bridge.attachImage(s1, {
      name: 'browser-screenshot.png',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    });
    bridge.attachPickedElement(s1, {
      selector: 'button#checkout',
      tagName: 'button',
      text: 'Checkout now',
      htmlExcerpt: '<button id="checkout">Checkout now</button>',
    });
    bridge.attachConsoleErrors(s2, [
      {
        kind: 'console',
        message: 'Uncaught Error: boom',
        url: 'http://localhost:3000/main.js:42',
        at: 1,
      },
      {
        kind: 'network',
        message: 'GET 500',
        url: 'http://localhost:3000/api/items',
        status: 500,
        at: 2,
      },
    ]);

    expect(bridge.pendingFor(s1)).toHaveLength(2);
    expect(bridge.pendingFor(s2)).toHaveLength(1);

    const s1Items = bridge.consume(s1);
    expect(s1Items[0]).toEqual({
      kind: 'image',
      image: {
        name: 'browser-screenshot.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    });
    expect(s1Items[1]).toEqual({
      kind: 'text',
      text: formatPickedElement({
        selector: 'button#checkout',
        tagName: 'button',
        text: 'Checkout now',
        htmlExcerpt: '<button id="checkout">Checkout now</button>',
      }),
    });
    expect(bridge.pendingFor(s1)).toEqual([]);
    expect(bridge.consume(s1)).toEqual([]);
    expect(bridge.pendingFor(s2)).toHaveLength(1);
  });

  it('ignores empty console error lists and formats element and error summaries cleanly', () => {
    const bridge = TestBed.inject(ComposerBridge);
    bridge.attachConsoleErrors(s1, []);
    expect(bridge.pendingFor(s1)).toEqual([]);

    const pickedText = formatPickedElement({
      selector: 'a.nav-link',
      tagName: 'a',
      text: 'Settings',
      htmlExcerpt: '<a class="nav-link" href="/settings">Settings</a>',
    });
    expect(pickedText).toContain('`<a>`');
    expect(pickedText).toContain('`a.nav-link`');
    expect(pickedText).toContain('Text: Settings');
    expect(pickedText).toContain('<a class="nav-link" href="/settings">Settings</a>');

    const errorText = formatConsoleErrors([
      { kind: 'console', message: 'Boom', url: 'http://localhost:3000/app.js:3', at: 1 },
      {
        kind: 'network',
        message: 'POST 404',
        url: 'http://localhost:3000/api/x',
        status: 404,
        at: 2,
      },
    ]);
    expect(errorText).toContain('[console] Boom (http://localhost:3000/app.js:3)');
    expect(errorText).toContain('[network] POST 404 (http://localhost:3000/api/x)');
  });
});
