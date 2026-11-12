import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { HlmDialogImports } from '@ui/dialog';
import { imageUrl } from './images';

/** An Image as the strip shows it. */
export interface ShownImage {
  readonly mimeType: string;
  readonly data: string;
}

/**
 * A row of fixed-height Image thumbnails, for one Message in the thread or the Images in the Composer. A click opens
 * the lightbox (Esc closes, ←/→ move within the row). In the Composer each thumbnail has a × on hover.
 */
@Component({
  selector: 'app-image-strip',
  imports: [HlmDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-wrap gap-2' },
  template: `
    @for (image of images(); track $index) {
      <div class="group relative" data-testid="image-thumbnail">
        <button
          type="button"
          class="focus-visible:ring-ring block overflow-hidden rounded-md border outline-none focus-visible:ring-2"
          aria-label="Open image"
          i18n-aria-label
          (click)="open.set($index)"
        >
          <img
            [src]="url(image)"
            alt=""
            class="w-auto object-cover"
            [class.h-24]="!removable()"
            [class.h-14]="removable()"
          />
        </button>
        @if (removable()) {
          <button
            type="button"
            class="bg-background text-foreground absolute -top-2 -right-2 hidden size-5 items-center justify-center rounded-full border text-xs leading-none group-focus-within:flex group-hover:flex"
            data-testid="image-remove"
            aria-label="Remove image"
            i18n-aria-label
            (click)="remove.emit($index)"
          >
            ×
          </button>
        }
      </div>
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
        @if (shown(); as image) {
          <img
            [src]="url(image)"
            alt=""
            class="mx-auto max-h-[80vh] w-auto object-contain"
            data-testid="lightbox-image"
          />
          @if (images().length > 1) {
            <p class="text-muted-foreground text-center text-xs tabular-nums">
              {{ (open() ?? 0) + 1 }} / {{ images().length }}
            </p>
          }
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ImageStrip {
  readonly images = input.required<ReadonlyArray<ShownImage>>();
  /** Composer thumbnails: smaller, with a × to remove. */
  readonly removable = input(false);
  readonly remove = output<number>();

  /** The Image the lightbox shows, by index. */
  protected readonly open = signal<number | null>(null);
  protected readonly shown = computed(() => {
    const index = this.open();
    return index === null ? null : (this.images()[index] ?? null);
  });

  protected url(image: ShownImage): string {
    return imageUrl(image);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const index = this.open();
    if (index === null) return;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const count = this.images().length;
    this.open.set((index + step + count) % count);
  }
}
