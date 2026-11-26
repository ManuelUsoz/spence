import type { MarkdownBlock } from '@ui/markdown';
import type {
  PullRequestDiffFile,
  ReviewThread,
} from '../../../shared/pull-requests/pull-requests.rpc';
import {
  processRenderRequest,
  renderMarkdownBlocks,
  type PrRenderRequest,
  type PrRenderResponse,
  type RenderedDiffFile,
} from './pr-render';

interface WorkerReplyMessage {
  readonly id: number;
  readonly response: PrRenderResponse | null;
}

/**
 * Renderer-side client for `pr-render.worker.ts`.
 * Offloads Shiki highlighting, word-diff decoration, Review thread anchoring, and Remark GFM parsing
 * to a module Web Worker when `Worker` is available, with a clean in-process fallback for jsdom/tests.
 */
export class PrRenderClient {
  private worker: Worker | null = null;
  private workerUnavailable = typeof Worker === 'undefined';
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (res: PrRenderResponse | null) => void;
    }
  >();

  private ensureWorker(): Worker | null {
    if (this.workerUnavailable) return null;
    if (this.worker !== null) return this.worker;
    try {
      const worker = new Worker(new URL('./pr-render.worker', import.meta.url), {
        type: 'module',
      });
      worker.addEventListener('message', (event: MessageEvent<WorkerReplyMessage>) => {
        const entry = this.pending.get(event.data.id);
        if (entry === undefined) return;
        this.pending.delete(event.data.id);
        entry.resolve(event.data.response);
      });
      worker.addEventListener('error', () => {
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          entry.resolve(null);
        }
        worker.terminate();
        this.worker = null;
        this.workerUnavailable = true;
      });
      this.worker = worker;
      return worker;
    } catch {
      this.workerUnavailable = true;
      return null;
    }
  }

  private async run(payload: PrRenderRequest): Promise<PrRenderResponse> {
    const worker = this.ensureWorker();
    if (worker === null) {
      return processRenderRequest(payload);
    }
    const id = this.nextId++;
    const response = await new Promise<PrRenderResponse | null>((resolve) => {
      this.pending.set(id, { resolve });
      worker.postMessage({ id, payload });
    });
    if (response !== null) return response;
    return processRenderRequest(payload);
  }

  async renderMarkdown(text: string): Promise<ReadonlyArray<MarkdownBlock>> {
    const res = await this.run({ kind: 'markdown', id: 'single', text });
    return res.kind === 'markdown' ? res.blocks : renderMarkdownBlocks(text);
  }

  async renderMarkdownBatch(
    items: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  ): Promise<ReadonlyMap<string, ReadonlyArray<MarkdownBlock>>> {
    if (items.length === 0) return new Map();
    const res = await this.run({ kind: 'markdownBatch', items });
    const map = new Map<string, ReadonlyArray<MarkdownBlock>>();
    if (res.kind === 'markdownBatch') {
      for (const item of res.results) {
        map.set(item.id, item.blocks);
      }
    }
    return map;
  }

  async renderDiffFile(
    file: PullRequestDiffFile,
    threads: ReadonlyArray<ReviewThread>,
  ): Promise<RenderedDiffFile> {
    const res = await this.run({ kind: 'diffFile', file, threads });
    if (res.kind === 'diffFile') return res.rendered;
    const fallback = await processRenderRequest({ kind: 'diffFile', file, threads });
    return fallback.kind === 'diffFile'
      ? fallback.rendered
      : { path: file.path, hunks: [], unanchoredThreads: [] };
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      entry.resolve(null);
    }
    this.pending.clear();
    if (this.worker !== null) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
