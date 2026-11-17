import { Directive } from '@angular/core';

/**
 * A pill-shaped control for the Composer's tray: a bordered, fully rounded 32px button on the card surface.
 * Put it on a `<button>` or a native select wrapper and add content (icon, label, chevron) yourself.
 */
@Directive({
  selector: 'button[appPill], a[appPill]',
  host: {
    class:
      'bg-card text-foreground hover:bg-muted border-border focus-visible:ring-ring/30 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs outline-none transition-colors focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
  },
})
export class Pill {}
