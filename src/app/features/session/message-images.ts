import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { HlmDialogImports } from '@ui/dialog';
import type { ImagePart } from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';
import {
  base64BytesOf,
  checkDisplayImage,
  DISPLAY_IMAGE_LIMITS,
  imageHeaderSize,
  imageUrl,
  type DisplayImageIssue,
} from './images';

/** The longest side of a thumbnail; the full-size source is only decoded when the lightbox opens. */
const THUMBNAIL_MAX_SIDE = 320;

type DisplayEntry =
  | { readonly kind: 'image'; readonly image: ImagePart; readonly issue: null }
  | { readonly kind: 'placeholder'; readonly image: null; readonly issue: DisplayImageIssue };

/** A downscaled thumbnail URL, or the data URL when this environment cannot resize images. */
const thumbnailOf = async (image: ImagePart): Promise<string> => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return imageUrl(image);
  }
  const bytes = base64BytesOf(image.data);
  if (bytes === null) return imageUrl(image);
  const size = imageHeaderSize(image.data);
  if (size === null) return imageUrl(image);
  const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  let bitmap: ImageBitmap | null = null;
  try {
    // Ask the decoder to produce the thumbnail size, not the full-size bitmap.
    bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }), {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'low',
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return imageUrl(image);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.8),
    );
    return blob === null ? imageUrl(image) : URL.createObjectURL(blob);
  } catch {
    return imageUrl(image);
  } finally {
    bitmap?.close();
  }
};

const isObjectUrl = (url: string): boolean => url.startsWith('blob:');

/**
 * The structured Images of one Message: bounded thumbnails, placeholders for unsupported, malformed, oversized or
 * excess payloads, and the existing lightbox for the full-size source.
 */
@Component({
  selector: 'app-message-images',
  imports: [HlmDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-wrap items-start gap-2' },
  template: `
    @for (entry of entries(); track $index; let index = $index) {
      @if (entry.kind === 'image') {
        <div class="group relative" data-testid="image-thumbnail">
          <button
            type="button"
            class="focus-visible:ring-ring block overflow-hidden rounded-md border outline-none focus-visible:ring-2"
            aria-label="Open image"
            i18n-aria-label
            (click)="openAt(index, $event.currentTarget)"
          >
            @if (thumbAt(index); as thumb) {
              <img [src]="thumb" alt="" class="h-24 w-auto object-cover" />
            } @else {
              <span class="bg-muted block h-24 w-24 animate-pulse"></span>
            }
          </button>
        </div>
      } @else {
        <div
          class="border-border text-muted-foreground flex h-24 max-w-48 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs"
          data-testid="image-placeholder"
          [attr.data-issue]="entry.issue"
        >
          {{ issueText(entry.issue) }}
        </div>
      }
    }

    <hlm-dialog
      [state]="shown() === null ? 'closed' : 'open'"
      (stateChanged)="$event === 'closed' && open.set(null)"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="sm:max-w-[min(90vw,64rem)]"
        data-testid="lightbox"
        closeLabel="Close"
        i18n-closeLabel
        (keydown)="onKeydown($event)"
      >
        <h2 hlmDialogTitle class="sr-only" i18n>Image</h2>
        @if (shownImage(); as entry) {
          <img
            [src]="fullSrc(entry)"
            alt=""
            class="mx-auto max-h-[80vh] w-auto object-contain"
            data-testid="lightbox-image"
          />
        }
        @if (imageCount() > 1) {
          <p class="text-muted-foreground text-center text-xs tabular-nums">
            {{ position() }} / {{ imageCount() }}
          </p>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class MessageImages {
  readonly images = input.required<ReadonlyArray<ImagePart>>();

  private readonly keymap = inject(Keymap);
  private opener: HTMLElement | null = null;

  protected readonly open = signal<number | null>(null);
  private readonly thumbs = signal<ReadonlyMap<number, string>>(new Map());

  protected readonly entries = computed<ReadonlyArray<DisplayEntry>>(() => {
    const images = this.images();
    const entries: Array<DisplayEntry> = [];
    let shown = 0;
    for (const image of images) {
      const issue = checkDisplayImage(image);
      if (issue !== null) {
        entries.push({ kind: 'placeholder', image: null, issue });
        continue;
      }
      if (shown >= DISPLAY_IMAGE_LIMITS.maxPerMessage) {
        entries.push({ kind: 'placeholder', image: null, issue: 'excess' });
        continue;
      }
      shown += 1;
      entries.push({ kind: 'image', image, issue: null });
    }
    return entries;
  });

  protected readonly shown = computed(() => {
    const index = this.open();
    return index === null ? null : (this.entries()[index] ?? null);
  });

  protected readonly shownImage = computed(() => {
    const entry = this.shown();
    return entry?.kind === 'image' ? entry : null;
  });

  protected readonly imageCount = computed(
    () => this.entries().filter((entry) => entry.kind === 'image').length,
  );

  protected readonly position = computed(() => {
    const index = this.open();
    if (index === null) return 0;
    return this.entries()
      .slice(0, index + 1)
      .filter((entry) => entry.kind === 'image').length;
  });

  constructor() {
    effect((onCleanup) => {
      const entries = this.entries();
      this.thumbs.set(new Map());
      let cancelled = false;
      const created: Array<string> = [];
      void (async () => {
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (entry?.kind !== 'image') continue;
          const thumb = await thumbnailOf(entry.image);
          if (cancelled) {
            if (isObjectUrl(thumb)) URL.revokeObjectURL(thumb);
            return;
          }
          if (isObjectUrl(thumb)) created.push(thumb);
          this.thumbs.update((known) => new Map(known).set(index, thumb));
        }
      })();
      onCleanup(() => {
        cancelled = true;
        for (const url of created) URL.revokeObjectURL(url);
      });
    });

    effect((onCleanup) => {
      if (this.shown() === null) return;
      const release = this.keymap.pushModal({
        opener: this.opener,
        onEscape: () => this.open.set(null),
      });
      onCleanup(release);
    });
  }

  protected thumbAt(index: number): string | null {
    return this.thumbs().get(index) ?? null;
  }

  protected fullSrc(entry: Extract<DisplayEntry, { kind: 'image' }>): string {
    return imageUrl(entry.image);
  }

  protected issueText(issue: DisplayImageIssue): string {
    switch (issue) {
      case 'unsupported':
        return $localize`Image format not supported`;
      case 'malformed':
        return $localize`Image could not be read`;
      case 'tooLarge':
        return $localize`Image is too large to show`;
      case 'excess':
        return $localize`Only ${DISPLAY_IMAGE_LIMITS.maxPerMessage}:limit: images are shown per Message`;
    }
  }

  protected openAt(index: number, target: EventTarget | null): void {
    this.opener = target instanceof HTMLElement ? target : null;
    this.open.set(index);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const index = this.open();
    if (index === null) return;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const entries = this.entries();
    for (let next = index + step; next >= 0 && next < entries.length; next += step) {
      if (entries[next]?.kind === 'image') {
        this.open.set(next);
        return;
      }
    }
  }
}
