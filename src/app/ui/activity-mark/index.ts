import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ActivityMarkKind = 'blocked' | 'error' | 'working';

/** A quiet static color-coded mark for a non-idle Session's status (blocked, error, or working). */
@Component({
  selector: 'app-activity-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (kind()) {
      @case ('blocked') {
        <svg
          data-testid="status-blocked"
          class="size-3.5 shrink-0 text-[var(--attention)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
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
          data-testid="status-error"
          class="size-3.5 shrink-0 text-[var(--destructive)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-label="Error"
          i18n-aria-label
          role="img"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
      }
      @case ('working') {
        <svg
          data-testid="status-working"
          class="size-3.5 shrink-0 text-[var(--working)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-label="Working"
          i18n-aria-label
          role="img"
        >
          <circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" />
        </svg>
      }
    }
  `,
})
export class ActivityMark {
  readonly kind = input.required<ActivityMarkKind>();
}
