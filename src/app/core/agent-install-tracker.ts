import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Effect, Stream } from 'effect';
import type {
  Agent,
  AgentId,
  InstallEvent,
  InstallFailure,
  InstallPhase,
} from '../../shared/agents/agents.rpc';
import type { DeviceId } from '../../shared/devices/devices.rpc';
import { DesktopApi } from './desktop-api';
import { onDevice } from './device-scope';
import { EffectRuntime } from './effect-runtime';

/** Live or settled state of a renderer-tracked `Agents.install` job keyed by `(device, agentId)`. */
export type TrackedInstall =
  | {
      readonly status: 'installing';
      readonly agent: Agent;
      readonly device: DeviceId | undefined;
      readonly phase: InstallPhase;
      readonly startedAt: number;
      readonly cancelling: boolean;
    }
  | {
      readonly status: 'installed';
      readonly agent: Agent;
      readonly device: DeviceId | undefined;
      readonly consumed: boolean;
    }
  | {
      readonly status: 'failed';
      readonly agent: Agent;
      readonly device: DeviceId | undefined;
      readonly reason: InstallFailure | 'Unreachable';
      readonly detail: string;
      readonly hasLog: boolean;
    };

/** Failure that occurred after every `AgentInstallOffer` view for `(device, agentId)` unmounted. */
export interface BackgroundInstallFailure {
  readonly id: number;
  readonly agent: Agent;
  readonly device: DeviceId | undefined;
  readonly reason: InstallFailure | 'Unreachable';
  readonly detail: string;
  readonly hasLog: boolean;
}

const jobKey = (device: DeviceId | undefined, agentId: AgentId): string =>
  `${device ?? 'local'}:${agentId}`;

const queryInstallStatus = (agentId: AgentId, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Agents.installStatus']({ agentId });
  }).pipe(onDevice(device));

const runInstallStream = (
  agentId: AgentId,
  device: DeviceId | undefined,
  onEvent: (event: InstallEvent) => void,
) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Agents.install']({ agentId }).pipe(
      Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
    );
  }).pipe(onDevice(device));

const cancelInstallCall = (agentId: AgentId, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Agents.cancelInstall']({ agentId });
  }).pipe(onDevice(device));

const openInstallLogCall = Effect.gen(function* () {
  const api = yield* DesktopApi;
  yield* api['Agents.openInstallLog']();
});

/**
 * Shared app-level tracker for active `Agents.install` streams.
 *
 * Keeps setup streams alive across view navigation so unmounting `AgentInstallOffer` never aborts a
 * running setup, lets remounted views reattach immediately with the original `startedAt` and live phase,
 * and surfaces failures that occur while unmounted via `backgroundFailures`.
 */
@Injectable({ providedIn: 'root' })
export class AgentInstallTracker {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyAborts = new AbortController();
  private readonly jobs = signal<ReadonlyMap<string, TrackedInstall>>(new Map());
  private readonly mountedViews = new Map<string, number>();
  private readonly activeControllers = new Map<string, AbortController>();
  private nextFailureId = 1;

  readonly backgroundFailures = signal<ReadonlyArray<BackgroundInstallFailure>>([]);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyAborts.abort();
      for (const controller of this.activeControllers.values()) {
        controller.abort();
      }
      this.activeControllers.clear();
    });
  }

  /** Reactive setup state for `(device, agentId)`, or `undefined` when idle. */
  stateFor(device: DeviceId | undefined, agentId: AgentId): TrackedInstall | undefined {
    return this.jobs().get(jobKey(device, agentId));
  }

  /**
   * Registers a mounted `AgentInstallOffer` for `(device, agent)` and checks main for any active
   * background setup job to reattach to. Returns an unmount callback.
   */
  mountView(agent: Agent, device: DeviceId | undefined): () => void {
    const key = jobKey(device, agent.id);
    this.mountedViews.set(key, (this.mountedViews.get(key) ?? 0) + 1);

    if (!this.activeControllers.has(key)) {
      void this.runtime
        .run(queryInstallStatus(agent.id, device), { signal: this.destroyAborts.signal })
        .then((exit) => {
          if (this.destroyAborts.signal.aborted) return;
          if (exit._tag === 'Success' && exit.value._tag === 'installing') {
            if (!this.activeControllers.has(key)) {
              this.attach(agent, device, exit.value.phase, exit.value.startedAt);
            }
          }
        });
    }

    return () => {
      const remaining = (this.mountedViews.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.mountedViews.set(key, remaining);
        return;
      }
      this.mountedViews.delete(key);
      const current = this.jobs().get(key);
      if (current?.status === 'installed' || current?.status === 'failed') {
        this.deleteJob(key);
      }
    };
  }

  /** Starts setup for `(agent, device)` (or attaches if already running). */
  start(agent: Agent, device: DeviceId | undefined): void {
    const key = jobKey(device, agent.id);
    if (this.activeControllers.has(key)) return;
    this.attach(agent, device, 'preparing', Date.now());
  }

  /** Explicitly cancels an active setup job on `(device, agentId)`. */
  async cancel(agentId: AgentId, device: DeviceId | undefined): Promise<void> {
    const key = jobKey(device, agentId);
    this.updateJob(key, (current) =>
      current?.status === 'installing' ? { ...current, cancelling: true } : current,
    );
    const exit = await this.runtime.run(cancelInstallCall(agentId, device), {
      signal: this.destroyAborts.signal,
    });
    if (this.destroyAborts.signal.aborted) return;
    if (exit._tag === 'Success') {
      const controller = this.activeControllers.get(key);
      if (controller !== undefined) {
        controller.abort();
        this.activeControllers.delete(key);
      }
      this.deleteJob(key);
      return;
    }
    this.updateJob(key, (current) =>
      current?.status === 'installing' ? { ...current, cancelling: false } : current,
    );
  }

  /** Marks an `'installed'` state as having emitted its `installed` output to the mounted view. */
  markInstalledEmitted(device: DeviceId | undefined, agentId: AgentId): void {
    const key = jobKey(device, agentId);
    this.updateJob(key, (current) =>
      current?.status === 'installed' && !current.consumed
        ? { ...current, consumed: true }
        : current,
    );
  }

  /** Removes a processed background failure notification. */
  dismissBackgroundFailure(id: number): void {
    this.backgroundFailures.update((items) => items.filter((item) => item.id !== id));
  }

  /** Opens the local install log in the system viewer. */
  async openLog(): Promise<void> {
    await this.runtime.run(openInstallLogCall, { signal: this.destroyAborts.signal });
  }

  private attach(
    agent: Agent,
    device: DeviceId | undefined,
    initialPhase: InstallPhase,
    initialStartedAt: number,
  ): void {
    const key = jobKey(device, agent.id);
    const controller = new AbortController();
    this.activeControllers.set(key, controller);
    this.setJob(key, {
      status: 'installing',
      agent,
      device,
      phase: initialPhase,
      startedAt: initialStartedAt,
      cancelling: false,
    });

    void this.runtime
      .run(
        runInstallStream(agent.id, device, (event) => this.onEvent(key, agent, device, event)),
        { signal: controller.signal },
      )
      .then((exit) => {
        if (this.activeControllers.get(key) === controller) {
          this.activeControllers.delete(key);
        }
        if (controller.signal.aborted || this.destroyAborts.signal.aborted) return;
        if (exit._tag === 'Failure') {
          this.recordFailure(key, agent, device, 'Unreachable', '', false);
          return;
        }
        if (this.jobs().get(key)?.status === 'installing') {
          this.deleteJob(key);
        }
      });
  }

  private onEvent(
    key: string,
    agent: Agent,
    device: DeviceId | undefined,
    event: InstallEvent,
  ): void {
    const current = this.jobs().get(key);
    const fallbackStart = current?.status === 'installing' ? current.startedAt : Date.now();
    switch (event._tag) {
      case 'downloadingRuntime':
        this.setJob(key, {
          status: 'installing',
          agent,
          device,
          phase: 'downloadingRuntime',
          startedAt: event.startedAt ?? fallbackStart,
          cancelling: current?.status === 'installing' ? current.cancelling : false,
        });
        return;
      case 'installingAdapter':
        this.setJob(key, {
          status: 'installing',
          agent,
          device,
          phase: 'installingAdapter',
          startedAt: event.startedAt ?? fallbackStart,
          cancelling: current?.status === 'installing' ? current.cancelling : false,
        });
        return;
      case 'succeeded':
        this.releaseController(key);
        this.setJob(key, {
          status: 'installed',
          agent,
          device,
          consumed: false,
        });
        return;
      case 'cancelled':
        this.releaseController(key);
        this.deleteJob(key);
        return;
      case 'failed':
        this.releaseController(key);
        this.recordFailure(key, agent, device, event.reason, event.detail, true);
        return;
    }
  }

  private releaseController(key: string): void {
    const controller = this.activeControllers.get(key);
    if (controller !== undefined) {
      this.activeControllers.delete(key);
      controller.abort();
    }
  }

  private recordFailure(
    key: string,
    agent: Agent,
    device: DeviceId | undefined,
    reason: InstallFailure | 'Unreachable',
    detail: string,
    hasLog: boolean,
  ): void {
    this.setJob(key, {
      status: 'failed',
      agent,
      device,
      reason,
      detail,
      hasLog,
    });
    if ((this.mountedViews.get(key) ?? 0) === 0) {
      const failure: BackgroundInstallFailure = {
        id: this.nextFailureId++,
        agent,
        device,
        reason,
        detail,
        hasLog,
      };
      this.backgroundFailures.update((items) => [...items, failure]);
    }
  }

  private setJob(key: string, value: TrackedInstall): void {
    this.jobs.update((map) => {
      const next = new Map(map);
      next.set(key, value);
      return next;
    });
  }

  private updateJob(
    key: string,
    fn: (current: TrackedInstall | undefined) => TrackedInstall | undefined,
  ): void {
    this.jobs.update((map) => {
      const prev = map.get(key);
      const updated = fn(prev);
      if (updated === prev) return map;
      const next = new Map(map);
      if (updated === undefined) next.delete(key);
      else next.set(key, updated);
      return next;
    });
  }

  private deleteJob(key: string): void {
    this.jobs.update((map) => {
      if (!map.has(key)) return map;
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  }
}
