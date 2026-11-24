import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A quiet static mark for a Session's activity (needs an answer, error, or running). */
@Component({
  selector: 'app-activity-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (kind()) {
      @case ('needsAnswer') {
        <svg
          data-testid="attention-needsAnswer"
          class="size-3.5 shrink-0 text-[var(--attention)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-label="Needs an answer"
          i18n-aria-label
          role="img"
        >
          <path d="M12 18h.01M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1.2-1.5 2.5" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      }
      @case ('error') {
        <svg
          data-testid="attention-error"
          class="size-3.5 shrink-0 text-[var(--destructive)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-label="Error"
          i18n-aria-label
          role="img"
        >
          <path d="M12 8v5m0 3h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      }
      @case ('running') {
        <svg
          data-testid="session-running"
          class="size-3.5 shrink-0 text-[var(--working)]"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-label="Running"
          i18n-aria-label
          role="img"
        >
          <circle cx="12" cy="12" r="4" />
        </svg>
      }
    }
  `,
})
export class ActivityMark {
  readonly kind = input.required<'needsAnswer' | 'error' | 'running'>();
}
