import { handleWorkerRequest } from './git-worker-core';
import { appendFile, writeFile } from 'node:fs/promises';
import type { WorkerRequest } from './worker-protocol';

export interface WorkerPortLike {
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly postMessage: (message: unknown) => void;
  readonly offMessage?: (listener: (message: unknown) => void) => void;
}

/**
 * Attaches the pure-Node Git request dispatcher to a worker parentPort (or test double).
 * Kept free of `Effect.run*` so the utility process stays minimal and lint-clean.
 */
export const connectWorkerPort = (
  port: WorkerPortLike,
  options?: {
    readonly onShutdown?: () => void;
    readonly beforeRequest?: (request: WorkerRequest) => Promise<void>;
    readonly beforeResponse?: (request: WorkerRequest, succeeded: boolean) => Promise<void>;
  },
): (() => void) => {
  const listener = (raw: unknown): void => {
    const request = raw as WorkerRequest;
    void (async () => {
      await options?.beforeRequest?.(request);
      const response = await handleWorkerRequest(request);
      await options?.beforeResponse?.(request, response.ok);
      port.postMessage(response);
      if (request.method === 'shutdown') {
        options?.onShutdown?.();
      }
    })();
  };
  port.onMessage(listener);
  return () => port.offMessage?.(listener);
};

interface ParentPortGlobal {
  readonly on: (event: 'message', listener: (event: { readonly data: unknown }) => void) => void;
  readonly off: (event: 'message', listener: (event: { readonly data: unknown }) => void) => void;
  readonly postMessage: (message: unknown) => void;
  readonly start?: () => void;
}

const parentPort = (process as { readonly parentPort?: ParentPortGlobal }).parentPort;

if (parentPort !== undefined) {
  const listeners = new Map<
    (message: unknown) => void,
    (event: { readonly data: unknown }) => void
  >();
  connectWorkerPort(
    {
      onMessage: (listener) => {
        const adapted = (event: { readonly data: unknown }): void => listener(event.data);
        listeners.set(listener, adapted);
        parentPort.on('message', adapted);
      },
      offMessage: (listener) => {
        const adapted = listeners.get(listener);
        if (adapted !== undefined) {
          parentPort.off('message', adapted);
          listeners.delete(listener);
        }
      },
      postMessage: (message) => parentPort.postMessage(message),
    },
    {
      onShutdown: () => process.exit(0),
      beforeRequest: async (request) => {
        const trace = process.env['SPENCE_E2E_WORKTREE_TRACE'];
        if (
          process.env['SPENCE_E2E'] === '1' &&
          trace !== undefined &&
          request.method === 'git.createWorktree'
        ) {
          await appendFile(trace, 'create\n');
        }
      },
      beforeResponse: async (request, succeeded) => {
        const marker = process.env['SPENCE_E2E_WORKTREE_PAUSE'];
        if (
          process.env['SPENCE_E2E'] !== '1' ||
          marker === undefined ||
          request.method !== 'git.createWorktree' ||
          !succeeded
        )
          return;
        await writeFile(marker, JSON.stringify({ pid: process.pid }));
        await new Promise<void>(() => {});
      },
    },
  );
  parentPort.start?.();
}
