import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One soft tint per known vendor; any other Agent falls back to the neutral tile. Never a logo. */
const VENDOR_CLASSES: Readonly<Record<string, string>> = {
  claude: 'bg-tile-claude text-tile-claude-foreground',
  codex: 'bg-tile-codex text-tile-codex-foreground',
  antigravity: 'bg-tile-antigravity text-tile-antigravity-foreground',
};
const NEUTRAL_CLASSES = 'bg-tile-neutral text-tile-neutral-foreground';

/** A monogram tile standing for an Agent's vendor. Decorative: the name is always written next to it. */
@Component({
  selector: 'app-agent-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class]': 'classes()',
  },
  template: `{{ monogram() }}`,
})
export class AgentTile {
  /** The Agent's id, used to pick the tint (`claude`, `codex`, `antigravity`, anything else is neutral). */
  readonly agentId = input.required<string>();
  /** The Agent's display name; its first two letters make the monogram. */
  readonly name = input.required<string>();
  readonly size = input<'sm' | 'md'>('md');

  protected readonly monogram = computed(() => {
    const letters = this.name().trim().slice(0, 2);
    return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
  });

  protected readonly classes = computed(() => {
    const tint = VENDOR_CLASSES[this.agentId()] ?? NEUTRAL_CLASSES;
    const size = this.size() === 'sm' ? 'size-5 text-[8px]' : 'size-[22px] text-[9px]';
    return `${tint} ${size} inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight`;
  });
}
