import { processRenderRequest, type PrRenderRequest } from './pr-render';

addEventListener(
  'message',
  (event: MessageEvent<{ readonly id: number; readonly payload: PrRenderRequest }>) => {
    const { id, payload } = event.data;
    void processRenderRequest(payload).then(
      (response) => postMessage({ id, response }),
      () => postMessage({ id, response: null }),
    );
  },
);
