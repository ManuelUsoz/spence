import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  resource,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmButtonImports } from '@ui/button';
import { HlmKbdImports } from '@ui/kbd';
import { Effect } from 'effect';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionSummary } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Keymap } from '../../core/keymap';
import { Tabs, titleOf } from '../../core/tabs';
import { listed, sessionTitle, shortAge } from './session-groups';
import { SessionsState } from './sessions-state';

const MAX_RECENT_SESSIONS = 5;

const listProjectSessions = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.list']({ projectId });
});

/**
 * Quiet empty workspace state shown when the active Project has 0 open Tabs, offering quick actions to open a new
 * Tab or jump straight into a recent Session in that Project.
 */
@Component({
  selector: 'app-empty-workspace',
  imports: [ActivityMark, HlmButtonImports, HlmKbdImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-full flex-col items-center justify-center px-6 py-12' },
  template: `
    <div
      class="flex w-full max-w-md flex-col items-center text-center"
      data-testid="empty-workspace"
    >
      <h2 class="font-display text-foreground text-xl" data-testid="empty-workspace-heading" i18n>
        No open Tabs in {{ project().name }}.
      </h2>
      <p class="text-muted-foreground mt-1.5 text-sm" i18n>
        Open a new Tab or pick a recent Session to continue.
      </p>

      <div class="mt-5 flex items-center gap-2">
        <button hlmBtn type="button" data-testid="empty-new-tab" (click)="newTab()">
          <span i18n>New Tab</span>
          <kbd hlmKbd class="font-mono font-normal opacity-80">{{
            keymap.format({ mod: true, key: 't' })
          }}</kbd>
        </button>
      </div>

      @if (recent().length > 0) {
        <div class="mt-8 w-full text-left">
          <div class="text-muted-foreground mb-1.5 px-2 text-xs font-medium" i18n>
            Recent Sessions
          </div>
          <div class="flex flex-col gap-0.5">
            @for (session of recent(); track session.id) {
              <button
                type="button"
                data-testid="empty-recent-session"
                class="hover:bg-accent text-foreground focus-visible:ring-ring flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none focus-visible:ring-2"
                (click)="openSession(session)"
              >
                @if (session.attention; as attention) {
                  <app-activity-mark [kind]="attention" />
                } @else if (session.running) {
                  <app-activity-mark kind="running" />
                }
                <span class="min-w-0 flex-1 truncate">{{ labelOf(session) }}</span>
                <span class="text-muted-foreground shrink-0 text-xs tabular-nums">{{
                  ageOf(session)
                }}</span>
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class EmptyWorkspace {
  private readonly runtime = inject(EffectRuntime);
  private readonly tabs = inject(Tabs);
  private readonly sessionsState = inject(SessionsState);
  protected readonly keymap = inject(Keymap);
  private readonly locale = inject(LOCALE_ID);

  readonly project = input.required<Project>();

  private readonly fallbackSessions = resource({
    params: () => {
      const id = this.project().id;
      return this.sessionsState.sessionsFor(id) === undefined ? id : undefined;
    },
    loader: async ({ params }) => {
      const exit = await this.runtime.run(listProjectSessions(params));
      if (exit._tag !== 'Success') return [] as ReadonlyArray<SessionSummary>;
      this.sessionsState.remember(exit.value, params);
      return exit.value;
    },
  });

  protected readonly recent = computed((): ReadonlyArray<SessionSummary> => {
    const id = this.project().id;
    const cached = this.sessionsState.sessionsFor(id);
    const all = cached ?? (this.fallbackSessions.hasValue() ? this.fallbackSessions.value() : []);
    return listed(all).slice(0, MAX_RECENT_SESSIONS);
  });

  protected newTab(): void {
    this.tabs.newTab(this.project().id);
  }

  protected openSession(session: SessionSummary): void {
    this.tabs.open({
      id: session.id,
      projectId: this.project().id,
      title: titleOf(session.title),
      ...(session.attention === undefined ? {} : { attention: session.attention }),
      ...(session.running === true ? { running: true } : {}),
    });
  }

  protected labelOf(session: SessionSummary): string {
    return sessionTitle(session.title);
  }

  protected ageOf(session: SessionSummary): string {
    return shortAge(session.lastActivityAt, Date.now(), this.locale);
  }
}
