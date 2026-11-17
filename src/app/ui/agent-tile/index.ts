import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** A vendor mark sits on the surface with no tile behind it; monochrome marks follow the text colour. An Agent without a mark gets a neutral monogram tile. */
const MARK_CLASSES = 'text-foreground';
const NEUTRAL_CLASSES = 'bg-tile-neutral text-tile-neutral-foreground';

/**
 * The vendor mark per Agent id (files in `public/agents/`). A `color` mark keeps its own colours; a `mono` mark is
 * painted with the tile's text colour so it follows the theme.
 */
const VENDOR_MARKS: Readonly<Record<string, { readonly src: string; readonly kind: 'color' | 'mono' }>> = {
  claude: { src: 'agents/claude.svg', kind: 'color' },
  antigravity: { src: 'agents/antigravity.svg', kind: 'color' },
  codex: { src: 'agents/codex.svg', kind: 'mono' },
  opencode: { src: 'agents/opencode.svg', kind: 'mono' },
};

/** A tile standing for an Agent's vendor: its mark, or a monogram for an Agent without one. Decorative. */
@Component({
  selector: 'app-agent-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class]': 'classes()',
  },
  template: `
    @if (mark(); as vendorMark) {
      @if (vendorMark.kind === 'color') {
        <img [src]="vendorMark.src" alt="" class="size-full" />
      } @else {
        <span
          class="size-full bg-current"
          [style.mask-image]="'url(' + vendorMark.src + ')'"
          [style.mask-size]="'contain'"
          [style.mask-repeat]="'no-repeat'"
          [style.mask-position]="'center'"
        ></span>
      }
    } @else {
      {{ monogram() }}
    }
  `,
})
export class AgentTile {
  /** The Agent's id, used to pick the mark and tint (anything unknown is a neutral monogram). */
  readonly agentId = input.required<string>();
  /** The Agent's display name; its first two letters make the monogram when there is no mark. */
  readonly name = input.required<string>();
  readonly size = input<'sm' | 'md'>('md');

  protected readonly mark = computed(() => VENDOR_MARKS[this.agentId()] ?? null);

  protected readonly monogram = computed(() => {
    const letters = this.name().trim().slice(0, 2);
    return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
  });

  protected readonly classes = computed(() => {
    const tint = this.mark() !== null ? MARK_CLASSES : NEUTRAL_CLASSES;
    const size = this.size() === 'sm' ? 'size-4 text-[8px]' : 'size-5 text-[9px]';
    return `${tint} ${size} inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight`;
  });
}
