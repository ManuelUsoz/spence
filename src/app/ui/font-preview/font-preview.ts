import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A small replica of the New Session screen: wallpaper, greeting, Composer stub and a code line. The caller passes
 * the font variables it wants shown, so the preview can differ from the app without touching it. Decorative.
 */
@Component({
  selector: 'app-font-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', class: 'block' },
  template: `
    <div
      class="bg-background border-border relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg border"
      [style]="vars()"
    >
      @if (background(); as url) {
        <img [src]="url" alt="" class="absolute inset-0 size-full object-cover" />
        <div class="bg-background/60 absolute inset-0"></div>
      }
      <div class="font-sans relative flex w-[78%] flex-col gap-4">
        <div class="flex flex-col gap-1">
          <p class="font-display text-foreground text-3xl leading-tight">{{ greeting() }}</p>
          <p class="text-muted-foreground text-sm">{{ subtitle() }}</p>
        </div>
        <div class="bg-card/90 border-border flex flex-col gap-3 rounded-xl border p-3 shadow-xs">
          <p class="text-muted-foreground text-sm">{{ placeholder() }}</p>
          <p class="text-foreground/80 text-xs">
            {{ codeLead() }}
            <code class="font-mono text-[11px]">{{ code() }}</code>
          </p>
        </div>
      </div>
    </div>
  `,
})
export class FontPreview {
  /** CSS variables (`--font-sans`, `--font-mono`, `--font-display`, ...) the preview is set in. */
  readonly vars = input.required<Readonly<Record<string, string>>>();
  /** A wallpaper behind the content; `null` for the solid theme background. */
  readonly background = input<string | null>(null);
  readonly greeting = input.required<string>();
  readonly subtitle = input.required<string>();
  readonly placeholder = input.required<string>();
  readonly codeLead = input.required<string>();
  readonly code = input.required<string>();
}
