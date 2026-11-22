import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { HlmSelectImports } from '@ui/select';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { TabId } from '../../../shared/tabs/tabs.rpc';
import { Tabs, titleOf } from '../../core/tabs';
import { sessionTitle } from './session-groups';
import { SessionsState } from './sessions-state';

/**
 * Bound-Session title & re-bind `@ui/select` picker for full-Tab `Changes` and `Workers` views.
 */
@Component({
  selector: 'app-panel-session-picker',
  imports: [HlmSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-1 items-center gap-1.5' },
  template: `
    <span aria-hidden="true" class="text-muted-foreground/60 shrink-0 text-xs select-none">·</span>
    <hlm-select
      data-testid="panel-session-picker"
      [value]="boundSessionId()"
      (valueChange)="rebindSession($event)"
    >
      <hlm-select-trigger
        size="sm"
        class="border-border/60 bg-background/60 hover:bg-accent h-6 max-w-48 min-w-0 px-2 text-xs"
        aria-label="Bound Session"
        i18n-aria-label
        data-testid="panel-session-picker-trigger"
      >
        <span class="truncate" data-testid="panel-bound-session">{{ boundSessionTitle() }}</span>
      </hlm-select-trigger>
      <hlm-select-content *hlmSelectPortal>
        @for (option of projectSessions(); track option.id) {
          <hlm-select-item [value]="option.id" data-testid="panel-session-option">{{
            option.title
          }}</hlm-select-item>
        }
      </hlm-select-content>
    </hlm-select>
  `,
})
export class PanelSessionPicker {
  readonly tabId = input<TabId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly boundSessionId = input.required<SessionId>();

  readonly boundSessionChange = output<SessionId>();

  private readonly tabs = inject(Tabs);
  private readonly sessionsState = inject(SessionsState);

  protected readonly boundSessionTitle = computed((): string => {
    const id = this.boundSessionId();
    const live = this.tabs.sessionStatus(id)?.title;
    if (live !== undefined && live !== null) return live;
    return this.sessionsState.titleFor(id, $localize`New Session`);
  });

  protected readonly projectSessions = computed(
    (): ReadonlyArray<{ readonly id: SessionId; readonly title: string }> => {
      const projectId = this.projectId();
      const boundId = this.boundSessionId();
      const byId = new Map<SessionId, string>();
      const resolveTitle = (id: SessionId, fallback?: string): string =>
        this.tabs.sessionStatus(id)?.title ?? fallback ?? $localize`New Session`;

      for (const summary of this.sessionsState.sessionsFor(projectId) ?? []) {
        if (summary.archivedAt !== undefined && summary.id !== boundId) continue;
        byId.set(summary.id, resolveTitle(summary.id, sessionTitle(summary.title)));
      }
      for (const meta of this.tabs.sessionsInProject(projectId)) {
        if (byId.has(meta.id)) continue;
        byId.set(meta.id, resolveTitle(meta.id, titleOf(meta.title) ?? undefined));
      }
      if (!byId.has(boundId)) {
        byId.set(boundId, this.boundSessionTitle());
      }
      return [...byId.entries()].map(([id, title]) => ({ id, title }));
    },
  );

  protected rebindSession(value: unknown): void {
    const target = this.projectSessions().find((item) => item.id === value);
    if (target !== undefined) {
      const tabId = this.tabId();
      if (tabId !== null) this.tabs.rebindTabOverlaySession(tabId, target.id);
      this.boundSessionChange.emit(target.id);
    }
  }
}
