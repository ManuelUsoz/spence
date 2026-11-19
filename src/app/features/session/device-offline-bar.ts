import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@ui/button';

/** Why a Remote Session cannot be driven now: its Device is being reached again, or it is away. */
export type DeviceAway = 'reconnecting' | 'offline';

/**
 * One line docked above the Composer while a Remote Session's Device is not connected: the Transcript stays
 * readable, sending waits, and Retry reaches the Device at once.
 */
@Component({
  selector: 'app-device-offline-bar',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="bg-muted flex items-center justify-between gap-2 rounded-md p-2 text-sm"
      data-testid="device-offline-bar"
      [attr.data-state]="away()"
      role="status"
    >
      <span class="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          class="size-1.5 shrink-0 rounded-full"
          [class]="away() === 'reconnecting' ? 'bg-[var(--attention)]' : 'bg-muted-foreground'"
        ></span>
        <span class="truncate" data-testid="device-offline-text">
          @if (away() === 'reconnecting') {
            <ng-container i18n>Reconnecting to {{ device() }}… Sending is paused.</ng-container>
          } @else {
            <ng-container i18n>{{ device() }} is offline. Sending is paused.</ng-container>
          }
        </span>
      </span>
      <button
        hlmBtn
        type="button"
        variant="outline"
        size="sm"
        data-testid="device-retry"
        [disabled]="retrying()"
        (click)="retry.emit()"
        i18n
      >
        Retry
      </button>
    </div>
  `,
})
export class DeviceOfflineBar {
  /** The Device's display name. */
  readonly device = input.required<string>();
  readonly away = input.required<DeviceAway>();
  readonly retrying = input<boolean>(false);
  readonly retry = output<void>();
}
