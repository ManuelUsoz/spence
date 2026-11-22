import { Effect, Schema } from 'effect';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { type BrowserError, PageId } from '../../src/shared/browser/browser.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import type { BrowserConsoleLogLevel, BrowserElementTarget } from './browser-host';
import { BrowserService } from './browser-service';

export const BrowserToolErrorReason = Schema.Literals([
  'BadRequest',
  'Internal',
  'NotActive',
  'NotFound',
  'PageNotFound',
  'NoActivePage',
  'InvalidUrl',
  'SchemeBlocked',
  'PermissionDenied',
  'RemoteUnsupported',
  'PickerCancelled',
  'Unavailable',
]).annotate({ identifier: 'BrowserToolErrorReason' });
export type BrowserToolErrorReason = typeof BrowserToolErrorReason.Type;

export type BrowserMcpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: 'image/png' };

export interface BrowserMcpOutcome {
  readonly content: ReadonlyArray<BrowserMcpContentBlock>;
  readonly isError?: boolean;
}

export const browserToolError = (
  reason: BrowserToolErrorReason,
  detail: string,
): BrowserMcpOutcome => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { reason, detail } }) }],
});

const textOutcome = (value: unknown): BrowserMcpOutcome => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

export interface BrowserMcpTools {
  readonly navigate: (input: {
    readonly url: string;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly back: (input: { readonly pageId?: PageId }) => Promise<BrowserMcpOutcome>;
  readonly forward: (input: { readonly pageId?: PageId }) => Promise<BrowserMcpOutcome>;
  readonly reload: (input: { readonly pageId?: PageId }) => Promise<BrowserMcpOutcome>;
  readonly pages: (input: {
    readonly action: 'list' | 'new' | 'select' | 'close';
    readonly pageId?: PageId;
    readonly url?: string;
  }) => Promise<BrowserMcpOutcome>;
  readonly snapshot: (input: { readonly pageId?: PageId }) => Promise<BrowserMcpOutcome>;
  readonly screenshot: (input: { readonly pageId?: PageId }) => Promise<BrowserMcpOutcome>;
  readonly console: (input: {
    readonly pageId?: PageId;
    readonly level?: BrowserConsoleLogLevel;
    readonly limit?: number;
  }) => Promise<BrowserMcpOutcome>;
  readonly network: (input: {
    readonly pageId?: PageId;
    readonly limit?: number;
    readonly statusMin?: number;
    readonly urlContains?: string;
  }) => Promise<BrowserMcpOutcome>;
  readonly click: (input: {
    readonly target: BrowserElementTarget;
    readonly pageId?: PageId;
    readonly button?: 'left' | 'right' | 'middle';
    readonly clickCount?: number;
  }) => Promise<BrowserMcpOutcome>;
  readonly fill: (input: {
    readonly target: BrowserElementTarget;
    readonly value: string;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly type: (input: {
    readonly text: string;
    readonly target?: BrowserElementTarget;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly press: (input: {
    readonly key: string;
    readonly target?: BrowserElementTarget;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly select: (input: {
    readonly target: BrowserElementTarget;
    readonly values: ReadonlyArray<string>;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly hover: (input: {
    readonly target: BrowserElementTarget;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly scroll: (input: {
    readonly direction?: 'up' | 'down' | 'left' | 'right';
    readonly amount?: number;
    readonly target?: BrowserElementTarget;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly waitFor: (input: {
    readonly text?: string;
    readonly url?: string;
    readonly selector?: string;
    readonly timeoutMs?: number;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly eval: (input: {
    readonly expression: string;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
  readonly handoff: (input: {
    readonly reason: string;
    readonly pageId?: PageId;
  }) => Promise<BrowserMcpOutcome>;
}

export interface RegisteredBrowserMcpServer {
  readonly server: {
    readonly type: 'http';
    readonly name: 'spence-browser';
    readonly url: string;
    readonly headers: Array<{ name: string; value: string }>;
  };
  readonly revoke: () => void;
}

type Args = Readonly<Record<string, unknown>>;

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly prepare: (
    args: Args,
  ) => ((tools: BrowserMcpTools) => Promise<BrowserMcpOutcome>) | undefined;
}

const record = (value: unknown): Args | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const optionalString = (args: Args, key: string): string | undefined | null => {
  if (!(key in args) || args[key] === undefined) return undefined;
  return typeof args[key] === 'string' ? args[key] : null;
};

const optionalNumber = (args: Args, key: string): number | undefined | null => {
  if (!(key in args) || args[key] === undefined) return undefined;
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? args[key] : null;
};

const optionalPageId = (args: Args): PageId | undefined | null => {
  const raw = optionalString(args, 'pageId');
  if (raw === undefined || raw === null) return raw;
  return raw.length > 0 ? PageId.make(raw) : null;
};

const extractTarget = (
  args: Args,
  allowTextTarget: boolean,
): BrowserElementTarget | undefined | null => {
  const ref = optionalString(args, 'ref');
  const selector = optionalString(args, 'selector');
  const text = allowTextTarget ? optionalString(args, 'text') : undefined;
  if (ref === null || selector === null || text === null) return null;
  if (ref === undefined && selector === undefined && text === undefined) return undefined;
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(selector === undefined ? {} : { selector }),
    ...(text === undefined ? {} : { text }),
  };
};

const pageIdProp = {
  type: 'string',
  description: 'Optional Page id; defaults to the active Page.',
} as const;
const targetProps = {
  ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e1").' },
  selector: { type: 'string', description: 'Optional CSS selector fallback.' },
  text: { type: 'string', description: 'Optional visible text fallback.' },
  pageId: pageIdProp,
} as const;

const toolSpecs: ReadonlyArray<ToolSpec> = [
  {
    name: 'navigate',
    description: 'Navigate the active (or specified) Browser Page to an http:// or https:// URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, pageId: pageIdProp },
      required: ['url'],
    },
    prepare: (args) => {
      const url = optionalString(args, 'url');
      const pageId = optionalPageId(args);
      if (typeof url !== 'string' || url.length === 0 || pageId === null) return undefined;
      return (tools) => tools.navigate({ url, ...(pageId === undefined ? {} : { pageId }) });
    },
  },
  {
    name: 'back',
    description: 'Navigate back in the Page history.',
    inputSchema: { type: 'object', properties: { pageId: pageIdProp } },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      if (pageId === null) return undefined;
      return (tools) => tools.back(pageId === undefined ? {} : { pageId });
    },
  },
  {
    name: 'forward',
    description: 'Navigate forward in the Page history.',
    inputSchema: { type: 'object', properties: { pageId: pageIdProp } },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      if (pageId === null) return undefined;
      return (tools) => tools.forward(pageId === undefined ? {} : { pageId });
    },
  },
  {
    name: 'reload',
    description: 'Reload the active or specified Page.',
    inputSchema: { type: 'object', properties: { pageId: pageIdProp } },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      if (pageId === null) return undefined;
      return (tools) => tools.reload(pageId === undefined ? {} : { pageId });
    },
  },
  {
    name: 'pages',
    description:
      'List, open ("new"), switch ("select"), or close ("close") Browser Pages in this Session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        pageId: pageIdProp,
        url: { type: 'string' },
      },
    },
    prepare: (args) => {
      const rawAction = optionalString(args, 'action') ?? 'list';
      if (
        rawAction !== 'list' &&
        rawAction !== 'new' &&
        rawAction !== 'select' &&
        rawAction !== 'close'
      ) {
        return undefined;
      }
      const pageId = optionalPageId(args);
      const url = optionalString(args, 'url');
      if (pageId === null || url === null) return undefined;
      if ((rawAction === 'select' || rawAction === 'close') && pageId === undefined) {
        return undefined;
      }
      return (tools) =>
        tools.pages({
          action: rawAction,
          ...(pageId === undefined ? {} : { pageId }),
          ...(url === undefined ? {} : { url }),
        });
    },
  },
  {
    name: 'snapshot',
    description:
      'Capture an accessibility outline of the Page with stable [ref=eN] element handles.',
    inputSchema: { type: 'object', properties: { pageId: pageIdProp } },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      if (pageId === null) return undefined;
      return (tools) => tools.snapshot(pageId === undefined ? {} : { pageId });
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a PNG screenshot of the Page.',
    inputSchema: { type: 'object', properties: { pageId: pageIdProp } },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      if (pageId === null) return undefined;
      return (tools) => tools.screenshot(pageId === undefined ? {} : { pageId });
    },
  },
  {
    name: 'console',
    description: 'Read recent console messages from the Page, optionally filtered by level.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: pageIdProp,
        level: { type: 'string', enum: ['info', 'warning', 'error', 'debug'] },
        limit: { type: 'number' },
      },
    },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      const level = optionalString(args, 'level');
      const limit = optionalNumber(args, 'limit');
      if (pageId === null || level === null || limit === null) return undefined;
      if (
        level !== undefined &&
        level !== 'info' &&
        level !== 'warning' &&
        level !== 'error' &&
        level !== 'debug'
      ) {
        return undefined;
      }
      return (tools) =>
        tools.console({
          ...(pageId === undefined ? {} : { pageId }),
          ...(level === undefined ? {} : { level }),
          ...(limit === undefined ? {} : { limit }),
        });
    },
  },
  {
    name: 'network',
    description: 'Read recent redacted network requests and responses for the Page.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: pageIdProp,
        limit: { type: 'number' },
        statusMin: { type: 'number' },
        urlContains: { type: 'string' },
      },
    },
    prepare: (args) => {
      const pageId = optionalPageId(args);
      const limit = optionalNumber(args, 'limit');
      const statusMin = optionalNumber(args, 'statusMin');
      const urlContains = optionalString(args, 'urlContains');
      if (pageId === null || limit === null || statusMin === null || urlContains === null) {
        return undefined;
      }
      return (tools) =>
        tools.network({
          ...(pageId === undefined ? {} : { pageId }),
          ...(limit === undefined ? {} : { limit }),
          ...(statusMin === undefined ? {} : { statusMin }),
          ...(urlContains === undefined ? {} : { urlContains }),
        });
    },
  },
  {
    name: 'click',
    description: 'Click an element targeted by ref, CSS selector, or visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetProps,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'number' },
      },
    },
    prepare: (args) => {
      const target = extractTarget(args, true);
      const pageId = optionalPageId(args);
      const button = optionalString(args, 'button');
      const clickCount = optionalNumber(args, 'clickCount');
      if (
        target === undefined ||
        target === null ||
        pageId === null ||
        button === null ||
        clickCount === null
      ) {
        return undefined;
      }
      if (button !== undefined && button !== 'left' && button !== 'right' && button !== 'middle') {
        return undefined;
      }
      return (tools) =>
        tools.click({
          target,
          ...(pageId === undefined ? {} : { pageId }),
          ...(button === undefined ? {} : { button }),
          ...(clickCount === undefined ? {} : { clickCount }),
        });
    },
  },
  {
    name: 'fill',
    description: 'Set the value of an input, textarea, or editable element.',
    inputSchema: {
      type: 'object',
      properties: { ...targetProps, value: { type: 'string' } },
      required: ['value'],
    },
    prepare: (args) => {
      const target = extractTarget(args, true);
      const value = optionalString(args, 'value');
      const pageId = optionalPageId(args);
      if (target === undefined || target === null || typeof value !== 'string' || pageId === null) {
        return undefined;
      }
      return (tools) => tools.fill({ target, value, ...(pageId === undefined ? {} : { pageId }) });
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused element or an optional target ref/selector.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: targetProps.ref,
        selector: targetProps.selector,
        pageId: pageIdProp,
      },
      required: ['text'],
    },
    prepare: (args) => {
      const text = optionalString(args, 'text');
      const target = extractTarget(args, false);
      const pageId = optionalPageId(args);
      if (typeof text !== 'string' || target === null || pageId === null) return undefined;
      return (tools) =>
        tools.type({
          text,
          ...(target === undefined ? {} : { target }),
          ...(pageId === undefined ? {} : { pageId }),
        });
    },
  },
  {
    name: 'press',
    description: 'Press a keyboard key or chord (e.g. "Enter", "Tab", "Escape", "Control+a").',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        ref: targetProps.ref,
        selector: targetProps.selector,
        pageId: pageIdProp,
      },
      required: ['key'],
    },
    prepare: (args) => {
      const key = optionalString(args, 'key');
      const target = extractTarget(args, false);
      const pageId = optionalPageId(args);
      if (typeof key !== 'string' || key.length === 0 || target === null || pageId === null) {
        return undefined;
      }
      return (tools) =>
        tools.press({
          key,
          ...(target === undefined ? {} : { target }),
          ...(pageId === undefined ? {} : { pageId }),
        });
    },
  },
  {
    name: 'select',
    description: 'Select one or more option values or labels in a <select> element.',
    inputSchema: {
      type: 'object',
      properties: {
        ...targetProps,
        value: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      },
    },
    prepare: (args) => {
      const target = extractTarget(args, true);
      const pageId = optionalPageId(args);
      const single = optionalString(args, 'value');
      const rawValues = args['values'];
      let values: Array<string> | undefined;
      if (Array.isArray(rawValues) && rawValues.every((v) => typeof v === 'string')) {
        values = [...rawValues];
      } else if (typeof single === 'string') {
        values = [single];
      }
      if (
        target === undefined ||
        target === null ||
        pageId === null ||
        single === null ||
        values === undefined
      ) {
        return undefined;
      }
      return (tools) =>
        tools.select({ target, values, ...(pageId === undefined ? {} : { pageId }) });
    },
  },
  {
    name: 'hover',
    description: 'Move the pointer over an element targeted by ref, CSS selector, or visible text.',
    inputSchema: { type: 'object', properties: { ...targetProps } },
    prepare: (args) => {
      const target = extractTarget(args, true);
      const pageId = optionalPageId(args);
      if (target === undefined || target === null || pageId === null) return undefined;
      return (tools) => tools.hover({ target, ...(pageId === undefined ? {} : { pageId }) });
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the Page window or a targeted container.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number' },
        ref: targetProps.ref,
        selector: targetProps.selector,
        pageId: pageIdProp,
      },
    },
    prepare: (args) => {
      const direction = optionalString(args, 'direction');
      const amount = optionalNumber(args, 'amount');
      const target = extractTarget(args, false);
      const pageId = optionalPageId(args);
      if (direction === null || amount === null || target === null || pageId === null) {
        return undefined;
      }
      if (
        direction !== undefined &&
        direction !== 'up' &&
        direction !== 'down' &&
        direction !== 'left' &&
        direction !== 'right'
      ) {
        return undefined;
      }
      return (tools) =>
        tools.scroll({
          ...(direction === undefined ? {} : { direction }),
          ...(amount === undefined ? {} : { amount }),
          ...(target === undefined ? {} : { target }),
          ...(pageId === undefined ? {} : { pageId }),
        });
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until visible text, a CSS selector, or a URL substring appears on the Page.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        url: { type: 'string' },
        selector: { type: 'string' },
        timeoutMs: { type: 'number' },
        pageId: pageIdProp,
      },
    },
    prepare: (args) => {
      const text = optionalString(args, 'text');
      const url = optionalString(args, 'url');
      const selector = optionalString(args, 'selector');
      const timeoutMs = optionalNumber(args, 'timeoutMs');
      const pageId = optionalPageId(args);
      if (
        text === null ||
        url === null ||
        selector === null ||
        timeoutMs === null ||
        pageId === null
      ) {
        return undefined;
      }
      if (text === undefined && url === undefined && selector === undefined) {
        return undefined;
      }
      return (tools) =>
        tools.waitFor({
          ...(text === undefined ? {} : { text }),
          ...(url === undefined ? {} : { url }),
          ...(selector === undefined ? {} : { selector }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(pageId === undefined ? {} : { pageId }),
        });
    },
  },
  {
    name: 'eval',
    description:
      'Evaluate a JavaScript expression in the Page main world and return its serialized value.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' }, pageId: pageIdProp },
      required: ['expression'],
    },
    prepare: (args) => {
      const expression = optionalString(args, 'expression');
      const pageId = optionalPageId(args);
      if (typeof expression !== 'string' || expression.length === 0 || pageId === null) {
        return undefined;
      }
      return (tools) => tools.eval({ expression, ...(pageId === undefined ? {} : { pageId }) });
    },
  },
  {
    name: 'handoff',
    description:
      'Pause the Turn and hand Browser control to the user to complete a step (e.g. sign in, 2FA, or verification gate) before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear explanation of what the user should complete in the Browser.',
        },
        pageId: pageIdProp,
      },
      required: ['reason'],
    },
    prepare: (args) => {
      const reason = optionalString(args, 'reason');
      const pageId = optionalPageId(args);
      if (typeof reason !== 'string' || reason.trim().length === 0 || pageId === null) {
        return undefined;
      }
      return (tools) =>
        tools.handoff({ reason: reason.trim(), ...(pageId === undefined ? {} : { pageId }) });
    },
  },
];

/** Bridges `BrowserService` Agent methods into `BrowserMcpTools` with active-Turn enforcement. */
export const makeBrowserMcpTools = Effect.fnUntraced(function* (input: {
  readonly sessionId: SessionId;
  readonly active: () => boolean;
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}) {
  const browserService = yield* BrowserService;
  const { sessionId, active, runEffect } = input;
  const run = <A>(
    effect: Effect.Effect<A, BrowserError>,
    format: (value: A) => BrowserMcpOutcome = textOutcome,
  ): Promise<BrowserMcpOutcome> =>
    runEffect(
      Effect.suspend(() =>
        active()
          ? effect.pipe(
              Effect.map(format),
              Effect.catch((error) => Effect.succeed(browserToolError(error.reason, error.detail))),
            )
          : Effect.succeed(
              browserToolError(
                'NotActive',
                'This capability is no longer active: its Turn has ended',
              ),
            ),
      ),
    );

  return {
    navigate: ({ url, pageId }) => run(browserService.agentNavigate(sessionId, url, pageId)),
    back: ({ pageId }) => run(browserService.agentBack(sessionId, pageId)),
    forward: ({ pageId }) => run(browserService.agentForward(sessionId, pageId)),
    reload: ({ pageId }) => run(browserService.agentReload(sessionId, pageId)),
    pages: ({ action, pageId, url }) => {
      switch (action) {
        case 'list':
          return run(browserService.agentListPages(sessionId));
        case 'new':
          return run(browserService.agentCreatePage(sessionId, url));
        case 'select':
          return pageId === undefined
            ? Promise.resolve(browserToolError('BadRequest', 'pageId is required for select'))
            : run(browserService.agentSelectPage(sessionId, pageId));
        case 'close':
          return pageId === undefined
            ? Promise.resolve(browserToolError('BadRequest', 'pageId is required for close'))
            : run(browserService.agentClosePage(sessionId, pageId));
      }
    },
    snapshot: ({ pageId }) =>
      run(browserService.agentSnapshot(sessionId, pageId), (snap) =>
        textOutcome(
          `Page: ${snap.pageId}\nURL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.snapshot}`,
        ),
      ),
    screenshot: ({ pageId }) =>
      run(browserService.agentScreenshot(sessionId, pageId), (shot) => ({
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          {
            type: 'text',
            text: JSON.stringify({
              pageId: shot.pageId,
              name: shot.name,
              mimeType: shot.mimeType,
            }),
          },
        ],
      })),
    console: (opts) => run(browserService.agentConsole(sessionId, opts)),
    network: (opts) => run(browserService.agentNetwork(sessionId, opts)),
    click: ({ target, pageId, button, clickCount }) =>
      run(
        browserService.agentClick(sessionId, target, {
          ...(pageId === undefined ? {} : { pageId }),
          ...(button === undefined ? {} : { button }),
          ...(clickCount === undefined ? {} : { clickCount }),
        }),
      ),
    fill: ({ target, value, pageId }) =>
      run(browserService.agentFill(sessionId, target, value, pageId)),
    type: ({ text, target, pageId }) =>
      run(browserService.agentType(sessionId, text, target, pageId)),
    press: ({ key, target, pageId }) =>
      run(browserService.agentPress(sessionId, key, target, pageId)),
    select: ({ target, values, pageId }) =>
      run(browserService.agentSelect(sessionId, target, values, pageId)),
    hover: ({ target, pageId }) => run(browserService.agentHover(sessionId, target, pageId)),
    scroll: (opts) => run(browserService.agentScroll(sessionId, opts)),
    waitFor: ({ pageId, ...condition }) =>
      run(browserService.agentWaitFor(sessionId, condition, pageId)),
    eval: ({ expression, pageId }) => run(browserService.agentEval(sessionId, expression, pageId)),
    handoff: ({ reason, pageId }) => run(browserService.agentHandoff(sessionId, reason, pageId)),
  } satisfies BrowserMcpTools;
});

/** Loopback Streamable HTTP MCP server exposing `spence-browser` capabilities per Session. */
export const makeBrowserMcpServer = Effect.gen(function* () {
  const handlers = new Map<
    string,
    (name: string, args: Args) => Promise<BrowserMcpOutcome | undefined>
  >();

  const server = createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const handler = token === undefined ? undefined : handlers.get(token);
    if (handler === undefined || request.method !== 'POST') {
      response.writeHead(403).end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 500_000) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        try {
          const message = record(JSON.parse(body));
          if (message === undefined || !('method' in message)) {
            response.writeHead(400).end();
            return;
          }
          const id = message['id'];
          if (id === undefined) {
            response.writeHead(202).end();
            return;
          }

          let result: unknown;
          if (message['method'] === 'initialize') {
            result = {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'spence-browser', version: '1.0.0' },
            };
          } else if (message['method'] === 'tools/list') {
            result = {
              tools: toolSpecs.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
            };
          } else if (message['method'] === 'tools/call') {
            const params = record(message['params']);
            const args = record(params?.['arguments'] ?? {});
            const name = params?.['name'];
            if (args === undefined || typeof name !== 'string') {
              response.writeHead(400).end();
              return;
            }
            const outcome = await handler(name, args);
            if (outcome === undefined) {
              response.writeHead(400).end();
              return;
            }
            if (handlers.get(token ?? '') !== handler) {
              response.writeHead(403).end();
              return;
            }
            result = {
              content: outcome.content,
              ...(outcome.isError === true ? { isError: true } : {}),
            };
          } else {
            response.writeHead(400).end();
            return;
          }

          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch (error) {
          const malformed = error instanceof SyntaxError;
          response.writeHead(malformed ? 400 : 500, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: { reason: malformed ? 'BadRequest' : 'Internal', detail: String(error) },
            }),
          );
        }
      })();
    });
  });

  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
  );

  const address = server.address();
  if (address === null || typeof address === 'string') {
    return yield* Effect.die('No browser MCP server address');
  }

  return {
    register: (tools: BrowserMcpTools): RegisteredBrowserMcpServer => {
      const token = randomBytes(32).toString('hex');
      handlers.set(token, async (name, args) => {
        const call = toolSpecs.find((spec) => spec.name === name)?.prepare(args);
        if (call === undefined) return undefined;
        return call(tools);
      });
      return {
        server: {
          type: 'http',
          name: 'spence-browser',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        },
        revoke: () => {
          handlers.delete(token);
        },
      };
    },
  };
});
