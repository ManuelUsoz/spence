import { Injectable, inject, signal } from '@angular/core';
import { toast } from '@ui/toast';
import { Effect, Exit, Stream } from 'effect';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId, SessionSummary } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { ProjectsState } from './projects-state';
import { sessionTitle } from './session-groups';

export interface SessionTarget {
  readonly id: SessionId;
  readonly title: string;
}

export interface ConfirmPrompt {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
  readonly onConfirm: () => Promise<void>;
}

const isTurnRunning = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  const head = yield* api['Session.events']({
    sessionId,
    afterSeq: Number.MAX_SAFE_INTEGER,
  }).pipe(Stream.runHead, Effect.exit);
  if (head._tag !== 'Success' || head.value._tag !== 'Some') return false;
  const first = head.value.value;
  return first._tag === 'Live' && first.state.runningTurn !== undefined;
});

const collectRunningIds = (ids: ReadonlyArray<SessionId>) =>
  Effect.forEach(
    ids,
    (id) => isTurnRunning(id).pipe(Effect.map((running) => (running ? [id] : []))),
    { concurrency: 5 },
  ).pipe(Effect.map((chunks) => chunks.flat()));

const cancelSessions = (ids: ReadonlyArray<SessionId>) =>
  Effect.forEach(ids, (id) => cancelSession(id).pipe(Effect.ignore), { discard: true });

const runBatchEffect = <T>(
  items: ReadonlyArray<T>,
  action: (item: T) => Effect.Effect<void, unknown, DesktopApi>,
) =>
  Effect.forEach(items, (item) =>
    action(item).pipe(
      Effect.exit,
      Effect.map((exit) => ({ item, ok: Exit.isSuccess(exit) })),
    ),
  ).pipe(
    Effect.map((results) => ({
      succeeded: results.filter((r) => r.ok).map((r) => r.item),
      failed: results.filter((r) => !r.ok).length,
    })),
  );

const notifyBatchFailure = (
  targets: ReadonlyArray<SessionTarget>,
  failed: number,
  messages: {
    readonly single: (title: string) => string;
    readonly one: () => string;
    readonly many: (count: number) => string;
  },
): void => {
  if (failed === 0) return;
  const first = targets.length === 1 ? targets[0] : undefined;
  toast.error(
    first !== undefined
      ? messages.single(first.title)
      : failed === 1
        ? messages.one()
        : messages.many(failed),
  );
};

const archiveSession = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.archive']({ sessionId });
});

const unarchiveSession = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.unarchive']({ sessionId });
});

const deleteSession = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.delete']({ sessionId });
});

/** Worker descendants main would delete with these Sessions; a failed lookup counts as none. */
const collectWorkerCount = (ids: ReadonlyArray<SessionId>) =>
  Effect.forEach(
    ids,
    (sessionId) =>
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        return yield* api['Session.countWorkers']({ sessionId });
      }).pipe(Effect.orElseSucceed(() => 0)),
    { concurrency: 5 },
  ).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)));

const cancelSession = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  yield* api['Session.cancel']({ sessionId });
});

const renameSession = Effect.fnUntraced(function* (sessionId: SessionId, title: string) {
  const api = yield* DesktopApi;
  yield* api['Session.rename']({ sessionId, title });
});

/** Shared Session archive/unarchive/delete/remove-project actions and confirmation state. */
@Injectable({ providedIn: 'root' })
export class SessionsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);

  private readonly _version = signal(0);
  private readonly _confirm = signal<ConfirmPrompt | null>(null);
  private readonly summaries = signal<ReadonlyMap<SessionId, SessionSummary>>(new Map());
  private readonly byProject = signal<ReadonlyMap<ProjectId, ReadonlyArray<SessionSummary>>>(
    new Map(),
  );

  readonly version = this._version.asReadonly();
  readonly confirm = this._confirm.asReadonly();

  /** Tracks loaded summaries so Tab menus and empty-workspace quick actions know each Project's Sessions. */
  remember(sessions: ReadonlyArray<SessionSummary>, projectId?: ProjectId): void {
    this.summaries.update((current) => {
      const next = new Map(current);
      for (const s of sessions) next.set(s.id, s);
      return next;
    });
    if (projectId !== undefined) {
      this.byProject.update((current) => {
        const next = new Map(current);
        next.set(projectId, sessions);
        return next;
      });
    }
  }

  sessionsFor(projectId: ProjectId): ReadonlyArray<SessionSummary> | undefined {
    return this.byProject().get(projectId);
  }

  isArchived(id: SessionId): boolean {
    return this.summaries().get(id)?.archivedAt !== undefined;
  }

  titleFor(id: SessionId, fallback: string): string {
    const found = this.summaries().get(id);
    return found === undefined ? fallback : sessionTitle(found.title);
  }

  reload(): void {
    this._version.update((v) => v + 1);
  }

  /** Renames a kept Session; an empty title restores the automatic title. */
  async rename(sessionId: SessionId, title: string): Promise<boolean> {
    const exit = await this.runtime.run(renameSession(sessionId, title));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not rename the Session.`);
      return false;
    }
    this.reload();
    return true;
  }

  dismissConfirm(): void {
    this._confirm.set(null);
  }

  async runConfirm(): Promise<void> {
    const prompt = this._confirm();
    if (prompt === null) return;
    this._confirm.set(null);
    await prompt.onConfirm();
  }

  async archive(targets: ReadonlyArray<SessionTarget>): Promise<void> {
    if (targets.length === 0) return;
    const running = await this.runningCount(targets.map((t) => t.id));
    if (running === 0) {
      await this.performArchive(targets);
      return;
    }
    const single = targets.length === 1 ? targets[0] : undefined;
    const title =
      single !== undefined
        ? $localize`Archive "${single.title}:title:"?`
        : $localize`Archive ${targets.length}:count: Sessions?`;
    const description =
      single !== undefined
        ? $localize`A Turn is still running and will be cancelled. Pending Permission requests will be cancelled, and its Tab will close.`
        : running === 1
          ? $localize`1 Turn is still running and will be cancelled. Pending Permission requests will be cancelled, and open Tabs will close.`
          : $localize`${running}:count: Turns are still running and will be cancelled. Pending Permission requests will be cancelled, and open Tabs will close.`;
    this._confirm.set({
      title,
      description,
      confirmLabel: $localize`Archive`,
      destructive: false,
      onConfirm: () => this.performArchive(targets),
    });
  }

  async unarchive(targets: ReadonlyArray<SessionTarget>): Promise<void> {
    if (targets.length === 0) return;
    const { failed } = await this.runBatch(targets, (t) => unarchiveSession(t.id));
    this.reload();
    notifyBatchFailure(targets, failed, {
      single: (title) => $localize`Could not unarchive "${title}:title:".`,
      one: () => $localize`Could not unarchive 1 Session.`,
      many: (count) => $localize`Could not unarchive ${count}:count: Sessions.`,
    });
  }

  async delete(targets: ReadonlyArray<SessionTarget>): Promise<void> {
    if (targets.length === 0) return;
    const running = await this.runningCount(targets.map((t) => t.id));
    const single = targets.length === 1 ? targets[0] : undefined;
    const title =
      single !== undefined
        ? $localize`Delete "${single.title}:title:"?`
        : $localize`Delete ${targets.length}:count: Sessions?`;
    const base =
      single !== undefined
        ? $localize`This Session will be permanently removed from Spence.`
        : $localize`These Sessions will be permanently removed from Spence.`;
    const runningNote =
      running === 0
        ? ''
        : running === 1
          ? single !== undefined
            ? $localize` Its running Turn will be stopped.`
            : $localize` 1 running Turn will be stopped.`
          : $localize` ${running}:count: running Turns will be stopped.`;
    const workers = await this.workerCount(targets.map((t) => t.id));
    const workersNote =
      workers === 0
        ? ''
        : workers === 1
          ? $localize` Its 1 Worker and its Transcript will be deleted too. To keep information from a Session, make a Fork first.`
          : $localize` Its ${workers}:count: Workers and their Transcripts will be deleted too. To keep information from a Session, make a Fork first.`;
    this._confirm.set({
      title,
      description: `${base}${runningNote}${workersNote}`,
      confirmLabel:
        single !== undefined ? $localize`Delete` : $localize`Delete ${targets.length}:count:`,
      destructive: true,
      onConfirm: () => this.performDelete(targets),
    });
  }

  async removeProject(project: Project, sessionIds: ReadonlyArray<SessionId>): Promise<void> {
    const runningIds = await this.runningSessionIds(sessionIds);
    if (runningIds.length === 0) {
      await this.performRemoveProject(project.id, []);
      return;
    }
    const description =
      runningIds.length === 1
        ? $localize`1 running Turn will be cancelled and its Tabs will close. Sessions are kept.`
        : $localize`${runningIds.length}:count: running Turns will be cancelled and its Tabs will close. Sessions are kept.`;
    this._confirm.set({
      title: $localize`Remove "${project.name}:name:"?`,
      description,
      confirmLabel: $localize`Remove`,
      destructive: true,
      onConfirm: () => this.performRemoveProject(project.id, runningIds),
    });
  }

  private async performArchive(targets: ReadonlyArray<SessionTarget>): Promise<void> {
    const { succeeded, failed } = await this.runBatch(targets, (t) => archiveSession(t.id));
    for (const item of succeeded) this.tabs.closeSession(item.id);
    this.reload();

    if (succeeded.length > 0) {
      const undoTargets = succeeded;
      const single = targets.length === 1 ? succeeded[0] : undefined;
      const message =
        single !== undefined
          ? $localize`Archived ${single.title}:title:`
          : succeeded.length === 1
            ? $localize`Archived 1 Session`
            : $localize`Archived ${succeeded.length}:count: Sessions`;
      toast(message, {
        action: {
          label: $localize`Undo`,
          onClick: () => void this.unarchive(undoTargets),
        },
      });
    }

    notifyBatchFailure(targets, failed, {
      single: (title) => $localize`Could not archive "${title}:title:".`,
      one: () => $localize`Could not archive 1 Session.`,
      many: (count) => $localize`Could not archive ${count}:count: Sessions.`,
    });
  }

  private async performDelete(targets: ReadonlyArray<SessionTarget>): Promise<void> {
    const { succeeded, failed } = await this.runBatch(targets, (t) => deleteSession(t.id));
    if (succeeded.length > 0) {
      this.tabs.closeSessionWithDescendants(succeeded.map((item) => item.id));
    }
    this.reload();

    notifyBatchFailure(targets, failed, {
      single: (title) => $localize`Could not delete "${title}:title:".`,
      one: () => $localize`Could not delete 1 Session.`,
      many: (count) => $localize`Could not delete ${count}:count: Sessions.`,
    });
  }

  private async performRemoveProject(
    projectId: Project['id'],
    runningIds: ReadonlyArray<SessionId>,
  ): Promise<void> {
    if (runningIds.length > 0) await this.runtime.run(cancelSessions(runningIds));
    this.tabs.closeProject(projectId);
    await this.projects.remove(projectId);
  }

  private async workerCount(ids: ReadonlyArray<SessionId>): Promise<number> {
    const exit = await this.runtime.run(collectWorkerCount(ids));
    return Exit.isSuccess(exit) ? exit.value : 0;
  }

  private async runningCount(ids: ReadonlyArray<SessionId>): Promise<number> {
    return (await this.runningSessionIds(ids)).length;
  }

  private async runningSessionIds(
    ids: ReadonlyArray<SessionId>,
  ): Promise<ReadonlyArray<SessionId>> {
    if (ids.length === 0) return [];
    const exit = await this.runtime.run(collectRunningIds(ids));
    return Exit.isSuccess(exit) ? exit.value : [];
  }

  private async runBatch<T>(
    items: ReadonlyArray<T>,
    action: (item: T) => Effect.Effect<void, unknown, DesktopApi>,
  ): Promise<{ readonly succeeded: ReadonlyArray<T>; readonly failed: number }> {
    const exit = await this.runtime.run(runBatchEffect(items, action));
    return Exit.isSuccess(exit) ? exit.value : { succeeded: [], failed: items.length };
  }
}
