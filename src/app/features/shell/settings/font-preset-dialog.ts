import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { FontPreview } from '@ui/font-preview';
import type { FontPreset } from '../../../../shared/settings/settings.rpc';
import { ChatBackgrounds } from '../../../core/chat-backgrounds';
import { FONT_PRESETS, fontPresetOf, fontVars } from '../../../core/font-presets';
import { Keymap } from '../../../core/keymap';

/**
 * Font presets: pick a pairing of Titles, Interface and Code fonts and see it on a replica of the New Session
 * screen before it touches the app. Apply commits the pick; Cancel and Esc leave everything as it was.
 */
@Component({
  selector: 'app-font-preset-dialog',
  imports: [HlmButtonImports, HlmDialogImports, FontPreview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (stateChanged)="onStateChange($event)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="sm:max-w-3xl"
        data-testid="font-preset-dialog"
        closeLabel="Close"
        i18n-closeLabel
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle i18n>Fonts</h2>
        </hlm-dialog-header>
        <div class="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <div
            class="flex flex-col gap-1"
            role="radiogroup"
            aria-label="Font preset"
            i18n-aria-label
            data-testid="font-preset-list"
          >
            @for (preset of presets; track preset.id) {
              <button
                type="button"
                role="radio"
                class="hover:bg-muted focus-visible:ring-ring flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2"
                [class]="candidate() === preset.id ? 'border-ring bg-muted' : 'border-transparent'"
                [attr.aria-checked]="candidate() === preset.id"
                [attr.data-testid]="'font-preset-' + preset.id"
                (click)="candidate.set(preset.id)"
              >
                <span class="text-sm">{{ preset.label }}</span>
                <span class="text-muted-foreground text-xs">{{ preset.summary }}</span>
              </button>
            }
          </div>
          <app-font-preview
            data-testid="font-preset-preview"
            [vars]="vars()"
            [background]="background()"
            [greeting]="greeting"
            [subtitle]="subtitle"
            [placeholder]="placeholder"
            [codeLead]="codeLead"
            [code]="code"
          />
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" data-testid="font-preset-cancel" (click)="cancel()" i18n>
            Cancel
          </button>
          <button
            hlmBtn
            data-testid="font-preset-apply"
            [disabled]="candidate() === current()"
            (click)="apply()"
            i18n
          >
            Apply
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class FontPresetDialog {
  private readonly backgrounds = inject(ChatBackgrounds);
  private readonly keymap = inject(Keymap);

  /** The preset in force. */
  readonly current = input.required<FontPreset>();
  readonly open = input.required<boolean>();
  readonly applied = output<FontPreset>();
  readonly closed = output<void>();

  protected readonly presets = FONT_PRESETS;
  protected readonly candidate = signal<FontPreset>('goeist');
  protected readonly vars = computed(() => fontVars(fontPresetOf(this.candidate()).id));
  protected readonly background = computed(() => this.backgrounds.resolve()?.url ?? null);

  protected readonly greeting = $localize`Good evening`;
  protected readonly subtitle = $localize`What are we doing?`;
  protected readonly placeholder = $localize`Message the Agent`;
  protected readonly codeLead = $localize`Edited`;
  protected readonly code = 'src/app/main.ts';

  constructor() {
    // Each opening starts from the preset in force, so a cancelled pick never lingers.
    effect(() => {
      if (this.open()) {
        const current = untracked(() => this.current());
        this.candidate.set(current);
      }
    });
    effect((onCleanup) => {
      if (!this.open()) return;
      const release = this.keymap.pushModal({ onEscape: () => this.cancel() });
      onCleanup(release);
    });
  }

  protected apply(): void {
    this.applied.emit(this.candidate());
    this.closed.emit();
  }

  protected cancel(): void {
    this.closed.emit();
  }

  protected onStateChange(next: string): void {
    if (next === 'closed') this.cancel();
  }
}
