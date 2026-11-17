import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Tab } from '../../core/tabs';

/** The active Tab's heading: its title and Project. An untitled (fresh) Tab shows none; the greeting names the Project. The Session view itself comes in through `SESSION_VIEW`. */
@Component({
  selector: 'app-session-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tab().title; as title) {
      <div class="flex flex-col gap-1" data-testid="session-placeholder">
        <h2 class="text-lg font-semibold">{{ title }}</h2>
        <p class="text-muted-foreground text-sm">{{ projectName() }}</p>
      </div>
    }
  `,
})
export class SessionPlaceholder {
  readonly tab = input.required<Tab>();
  readonly projectName = input('');
}
