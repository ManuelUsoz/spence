import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { SendMode } from '../../../shared/settings/settings.rpc';

/**
 * The Composer's send mode while a Turn runs: Queue lines a Message up for when the Turn ends, Steer sends it
 * now into the running Turn. A radiogroup of two; Steer is disabled when the Agent cannot be steered.
 */
@Component({
  selector: 'app-send-mode-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      role="radiogroup"
      aria-label="Send mode"
      i18n-aria-label
      data-testid="send-mode"
      class="bg-muted flex gap-0.5 rounded-full p-0.5 text-xs"
      (keydown.arrowLeft)="move($event, 'queue')"
      (keydown.arrowRight)="move($event, 'steer')"
    >
      <button
        type="button"
        role="radio"
        data-testid="send-mode-queue"
        title="Queue: sent when the Turn ends"
        i18n-title
        [class]="itemClass('queue')"
        [attr.aria-checked]="mode() === 'queue'"
        [tabindex]="mode() === 'queue' ? 0 : -1"
        (click)="pick('queue')"
        i18n
      >
        Queue
      </button>
      <button
        type="button"
        role="radio"
        data-testid="send-mode-steer"
        [title]="steerTitle()"
        [class]="itemClass('steer')"
        [attr.aria-checked]="mode() === 'steer'"
        [attr.aria-disabled]="steeringSupported() ? null : true"
        [tabindex]="mode() === 'steer' ? 0 : -1"
        (click)="pick('steer')"
        i18n
      >
        Steer
      </button>
    </div>
  `,
})
export class SendModeChip {
  readonly mode = input.required<SendMode>();
  readonly steeringSupported = input.required<boolean>();
  readonly modeChange = output<SendMode>();

  protected readonly steerTitle = () =>
    this.steeringSupported()
      ? $localize`Steer: sent now, into the running Turn`
      : $localize`This Agent cannot be steered`;

  protected itemClass(mode: SendMode): string {
    const base =
      'focus-visible:ring-ring flex h-[26px] items-center rounded-full px-2.5 outline-none focus-visible:ring-2';
    if (mode === this.mode()) return `${base} bg-card font-medium shadow-xs`;
    const disabled = mode === 'steer' && !this.steeringSupported();
    return `${base} text-muted-foreground ${disabled ? 'cursor-not-allowed opacity-50' : ''}`;
  }

  protected pick(mode: SendMode): void {
    if (mode === 'steer' && !this.steeringSupported()) return;
    if (mode !== this.mode()) this.modeChange.emit(mode);
  }

  protected move(event: Event, mode: SendMode): void {
    event.preventDefault();
    this.pick(mode);
  }
}
