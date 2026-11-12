import type { MessagePort } from 'node:worker_threads';
import type { MessagePortAdapter } from '../../src/shared/rpc/message-port-protocol';
import type { IpcServerPort } from './ipc-server';

// A Node `MessageChannel` standing in for Electron's `MessageChannelMain` in specs: one end for main's server, the
// other for the renderer's client protocol.

/** Main's end of a port pair, as `layerIpcServer` sees an Electron `MessagePortMain`. */
export const serverPort = (port: MessagePort): IpcServerPort => {
  const wrapped = new Map<unknown, (data: Uint8Array | string) => void>();
  return {
    on: ((event: 'message' | 'close', listener: (e?: { data: Uint8Array | string }) => void) => {
      if (event === 'close') return void port.on('close', () => listener());
      const onData = (data: Uint8Array | string) => listener({ data });
      wrapped.set(listener, onData);
      port.on('message', onData);
    }) as IpcServerPort['on'],
    off: (_event, listener) => {
      const onData = wrapped.get(listener);
      if (onData) port.off('message', onData);
    },
    postMessage: (message) => port.postMessage(message),
    start: () => port.start(),
    close: () => port.close(),
  };
};

/** The renderer's end of a port pair. */
export const clientPort = (port: MessagePort): MessagePortAdapter => ({
  postMessage: (data) => port.postMessage(data),
  onMessage: (callback) => void port.on('message', callback),
  close: () => port.close(),
});
