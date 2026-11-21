import { highlight } from './file-highlight';
import type { FileLanguage } from './file-language';

addEventListener(
  'message',
  (event: MessageEvent<{ id: number; content: string; lang: FileLanguage }>) => {
    const { id, content, lang } = event.data;
    void highlight(content, lang).then(
      (lines) => postMessage({ id, lines }),
      () => postMessage({ id, lines: null }),
    );
  },
);
