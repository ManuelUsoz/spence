import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import type { DeviceId } from '../../../../shared/devices/devices.rpc';
import { HostedViewers } from '../../../core/hosted-viewers';

/**
 * The Remote devices connected to this Device while it hosts, by name, each with Disconnect (it stays paired and may
 * connect again) and Unpair. The only place hosting activity is listed: no toasts, notifications or badges.
 */
@Component({
  selector: 'app-settings-viewers',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-viewers' },
  template: `
    <h3 class="text-muted-foreground mt-4 mb-1 text-xs" i18n>Connected now</h3>
    @if (hosted.viewers(); as viewers) {
      @for (viewer of viewers; track viewer.id) {
        <div
          class="border-border/60 flex items-center gap-6 border-t py-3"
          data-testid="viewer"
          [attr.data-device-id]="viewer.id"
        >
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden="true" class="bg-online size-1.5 shrink-0 rounded-full"></span>
            <span class="truncate text-sm" data-testid="viewer-name">{{ viewer.name }}</span>
          </div>
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            data-testid="viewer-disconnect"
            (click)="onDisconnect(viewer.id)"
            i18n
          >
            Disconnect
          </button>
          <button
            hlmBtn
            type="button"
            variant="destructive"
            size="sm"
            data-testid="viewer-unpair"
            (click)="onUnpair(viewer.id)"
            i18n
          >
            Unpair
          </button>
        </div>
      } @empty {
        <p
          class="text-muted-foreground border-border/60 border-t py-3 text-sm"
          data-testid="viewers-empty"
          i18n
        >
          No Remote device is connected.
        </p>
      }
    } @else {
      <p class="text-muted-foreground border-border/60 border-t py-3 text-sm" i18n>Loading…</p>
    }
  `,
})
export class SettingsViewers {
  protected readonly hosted = inject(HostedViewers);

  protected async onDisconnect(id: DeviceId): Promise<void> {
    await this.hosted.disconnect(id);
  }

  protected async onUnpair(id: DeviceId): Promise<void> {
    await this.hosted.unpair(id);
  }
}
