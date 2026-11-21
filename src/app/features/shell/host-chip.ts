import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HostedViewers } from '../../core/hosted-viewers';

/** Quiet status pill shown when Remote devices are connected to this Spence host. */
@Component({
  selector: 'app-host-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (serving(); as viewers) {
      <span
        class="text-muted-foreground flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs whitespace-nowrap"
        data-testid="host-chip"
        [attr.title]="viewerNames()"
      >
        <span aria-hidden="true" class="bg-online size-1.5 shrink-0 rounded-full"></span>
        <span i18n>{viewers.length, plural,
          =1 {Serving 1 Remote device}
          other {Serving {{ viewers.length }} Remote devices}
        }</span>
      </span>
    }
  `,
})
export class HostChip {
  private readonly hosted = inject(HostedViewers);

  protected readonly serving = computed(() => {
    const viewers = this.hosted.viewers();
    return viewers === null || viewers.length === 0 ? null : viewers;
  });

  protected readonly viewerNames = computed(() =>
    (this.serving() ?? []).map((viewer) => viewer.name).join(', '),
  );
}
