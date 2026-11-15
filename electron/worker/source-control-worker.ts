import { handleWorkerRequest } from './git-worker-core';
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
  options?: { readonly onShutdown?: () => void },
): (() => void) => {
  const listener = (raw: unknown): void => {
    const request = raw as WorkerRequest;
    void handleWorkerRequest(request).then((response) => {
      port.postMessage(response);
      if (request.method === 'shutdown') {
        options?.onShutdown?.();
      }
    });
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
    },
  );
  parentPort.start?.();
}
