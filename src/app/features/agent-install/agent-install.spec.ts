import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { clearTranslations, loadTranslations } from '@angular/localize';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { type Cause, Effect, Queue, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentId,
  AgentsRpcs,
  type Agent,
  type InstallEvent,
  type InstallStatus,
} from '../../../shared/agents/agents.rpc';
import { DEVICE_SCOPE_HEADER, DeviceId } from '../../../shared/devices/devices.rpc';
import { AgentInstallTracker, installFailureMessage } from '../../core/agent-install-tracker';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DeviceScopeDirective } from '../../core/device-scope.directive';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { AgentInstallOffer } from './agent-install';

const claude: Agent = {
  id: AgentId.make('claude'),
  name: 'Claude',
  installKind: 'npm',
  package: '@agentclientprotocol/claude-agent-acp',
  installed: false,
  qualifiedVersion: '0.106.0',
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: true,
    resume: true,
    contextUsage: true,
    supportsCompaction: true,
    supportsIsolatedSummary: true,
    modelChangePreservesContext: true,
    crossDeviceTools: true,
  },
};

interface Served {
  readonly events: Stream.Stream<InstallEvent> | (() => Stream.Stream<InstallEvent>);
  readonly agent?: Agent;
  readonly rescanInstalled?: () => boolean;
  readonly headersSeen?: Array<string | undefined>;
  readonly installStatus?: () => InstallStatus;
  readonly onCancel?: (
    agentId: AgentId,
    deviceHeader: string | undefined,
  ) => Effect.Effect<void> | void;
  readonly rescanCalls?: Array<string | undefined>;
}

let logOpened = 0;

const handlers = ({
  events,
  agent = claude,
  rescanInstalled,
  headersSeen,
  installStatus,
  onCancel,
  rescanCalls,
}: Served) =>
  AgentsRpcs.toLayer({
    'Agents.list': () => Effect.die('AgentInstallOffer should call Agents.rescan'),
    'Agents.rescan': (_payload, { headers }) => {
      headersSeen?.push(headers[DEVICE_SCOPE_HEADER]);
      rescanCalls?.push(headers[DEVICE_SCOPE_HEADER]);
      return Effect.succeed([{ ...agent, installed: rescanInstalled?.() ?? agent.installed }]);
    },
    'Agents.install': (_payload, { headers }) => {
      headersSeen?.push(headers[DEVICE_SCOPE_HEADER]);
      return typeof events === 'function' ? events() : events;
    },
    'Agents.cancelInstall': ({ agentId }, { headers }) => {
      headersSeen?.push(headers[DEVICE_SCOPE_HEADER]);
      const result = onCancel?.(agentId, headers[DEVICE_SCOPE_HEADER]);
      return result ?? Effect.void;
    },
    'Agents.installStatus': (_payload, { headers }) => {
      headersSeen?.push(headers[DEVICE_SCOPE_HEADER]);
      return Effect.succeed(installStatus?.() ?? ({ _tag: 'idle' } as const));
    },
    'Agents.openInstallLog': () =>
      Effect.sync(() => {
        logOpened += 1;
      }),
  });

const mount = (served: Served): ComponentFixture<AgentInstallOffer> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) }],
  });
  const fixture = TestBed.createComponent(AgentInstallOffer);
  fixture.componentRef.setInput('agent', served.agent ?? claude);
  fixture.detectChanges();
  return fixture;
};

@Component({
  selector: 'app-remote-host',
  imports: [DeviceScopeDirective, AgentInstallOffer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [appDeviceScope]="device()">
      <app-agent-install [agent]="agent()" />
    </div>
  `,
})
class RemoteHost {
  readonly device = input<DeviceId | undefined>(undefined);
  readonly agent = input.required<Agent>();
}

const mountOnDevice = (served: Served, device: DeviceId): ComponentFixture<RemoteHost> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) }],
  });
  const fixture = TestBed.createComponent(RemoteHost);
  fixture.componentRef.setInput('device', device);
  fixture.componentRef.setInput('agent', served.agent ?? claude);
  fixture.detectChanges();
  return fixture;
};

const text = (fixture: ComponentFixture<unknown>): string => {
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
};

const byTestId = (fixture: ComponentFixture<unknown>, id: string): HTMLElement | null =>
  (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

const click = (fixture: ComponentFixture<unknown>, id: string): void => {
  const button = byTestId(fixture, id);
  if (button === null) throw new Error(`no ${id}`);
  button.click();
  fixture.detectChanges();
};

const waitForText = (fixture: ComponentFixture<unknown>, expected: string) =>
  vi.waitFor(() => expect(text(fixture)).toContain(expected));

beforeEach(() => {
  logOpened = 0;
});

afterEach(() => {
  clearTranslations();
  vi.useRealTimers();
});

describe('AgentInstallOffer', () => {
  it('offers one-click Set up without confirmation modal, noNpm dead-end, or npm install -g command', async () => {
    const fixture = mount({
      events: Stream.make(
        { _tag: 'downloadingRuntime' },
        { _tag: 'installingAdapter' },
        { _tag: 'succeeded' },
      ),
    });
    expect(text(fixture)).toContain("Claude isn't installed.");
    expect(byTestId(fixture, 'install')?.textContent?.trim()).toBe('Set up');
    expect(byTestId(fixture, 'show-command')).toBeNull();
    expect(byTestId(fixture, 'confirm-install')).toBeNull();
    expect(byTestId(fixture, 'needs-node')).toBeNull();
    expect(text(fixture)).not.toContain('npm install');

    const installed = vi.fn();
    fixture.componentInstance.installed.subscribe(installed);
    click(fixture, 'install');
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    expect(text(fixture)).toContain('Claude is installed.');
  });

  it('shows phased progress (downloadingRuntime -> installingAdapter) and elapsed timer after 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const fixture = mount({
      events: Stream.concat(
        Stream.make({ _tag: 'downloadingRuntime' as const, startedAt: Date.now() }),
        Stream.never,
      ),
    });
    click(fixture, 'install');
    await waitForText(fixture, 'Downloading runtime…');
    expect(byTestId(fixture, 'install-progress')).not.toBeNull();
    expect(byTestId(fixture, 'install-elapsed')).toBeNull();

    vi.advanceTimersByTime(12_000);
    await waitForText(fixture, '12 s');
    expect(byTestId(fixture, 'install-elapsed')).not.toBeNull();
    fixture.destroy();
  });

  it('shows Installing <Agent>… during installingAdapter phase', async () => {
    const fixture = mount({
      events: Stream.concat(Stream.make({ _tag: 'installingAdapter' as const }), Stream.never),
    });
    click(fixture, 'install');
    await waitForText(fixture, 'Installing Claude…');
    fixture.destroy();
  });

  it('on failure shows concise reason, Try again, and Open log (without manual command), and retries on Try again', async () => {
    let attempt = 0;
    const fixture = mount({
      events: () => {
        attempt += 1;
        return attempt === 1
          ? Stream.make(
              { _tag: 'downloadingRuntime' as const },
              {
                _tag: 'failed' as const,
                reason: 'ChecksumMismatch' as const,
                detail: 'SHA-256 mismatch for node-v22.14.0',
                logPath: '/data/spence/logs/agents/install.log',
              },
            )
          : Stream.make({ _tag: 'installingAdapter' as const }, { _tag: 'succeeded' as const });
      },
    });
    const installed = vi.fn();
    fixture.componentInstance.installed.subscribe(installed);

    click(fixture, 'install');
    await waitForText(fixture, 'The downloaded Node runtime failed verification.');
    expect(text(fixture)).toContain('SHA-256 mismatch for node-v22.14.0');
    expect(byTestId(fixture, 'install-command')).toBeNull();
    expect(byTestId(fixture, 'retry-install')).not.toBeNull();

    click(fixture, 'open-log');
    await vi.waitFor(() => expect(logOpened).toBe(1));

    click(fixture, 'retry-install');
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    expect(text(fixture)).toContain('Claude is installed.');
  });

  it('routes Agents.install with DeviceScope header and hides Open log when targeting a Remote device', async () => {
    const remoteId = DeviceId.make('dev-studio');
    const headersSeen: Array<string | undefined> = [];
    const fixture = mountOnDevice(
      {
        headersSeen,
        events: Stream.make(
          { _tag: 'downloadingRuntime' },
          {
            _tag: 'failed',
            reason: 'RuntimeDownloadFailed',
            detail: 'Network error',
            logPath: '/remote/install.log',
          },
        ),
      },
      remoteId,
    );
    click(fixture, 'install');
    await waitForText(fixture, "Couldn't download the Node runtime for Claude.");
    expect(headersSeen).toContain(remoteId);
    expect(byTestId(fixture, 'open-log')).toBeNull();
    expect(byTestId(fixture, 'retry-install')).not.toBeNull();
  });

  it('shows official non-npm instructions and Re-scan for native Agents via Agents.rescan', async () => {
    let installedNow = false;
    const rescanCalls: Array<string | undefined> = [];
    const nativeAgent: Agent = {
      ...claude,
      id: AgentId.make('antigravity'),
      name: 'Antigravity',
      installKind: 'native',
      package: '',
      installInstructions:
        'Install Antigravity from https://antigravity.google/download and ensure `agy` is on PATH.',
    };
    const fixture = mount({
      events: Stream.empty,
      agent: nativeAgent,
      rescanInstalled: () => installedNow,
      rescanCalls,
    });
    const installed = vi.fn();
    fixture.componentInstance.installed.subscribe(installed);

    await waitForText(fixture, 'Install Antigravity from https://antigravity.google/download');
    expect(byTestId(fixture, 'needs-node')).toBeNull();
    expect(byTestId(fixture, 'install')).toBeNull();
    expect(byTestId(fixture, 'rescan-agents')).not.toBeNull();

    click(fixture, 'rescan-agents');
    await waitForText(fixture, 'Still not found on PATH.');
    expect(rescanCalls).toHaveLength(1);

    installedNow = true;
    click(fixture, 'rescan-agents');
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    expect(rescanCalls).toHaveLength(2);
    expect(text(fixture)).toContain('Antigravity is installed.');
  });

  it('shows inline Cancel during active setup, calls Agents.cancelInstall with DeviceScope, and returns to offer', async () => {
    const remoteId = DeviceId.make('dev-studio');
    const cancelled: Array<{ agentId: AgentId; device: string | undefined }> = [];
    const queue = Effect.runSync(Queue.unbounded<InstallEvent, Cause.Done>());
    const fixture = mountOnDevice(
      {
        events: () => Stream.fromQueue(queue),
        onCancel: (agentId, device) =>
          Effect.gen(function* () {
            cancelled.push({ agentId, device });
            yield* Queue.offer(queue, { _tag: 'cancelled' });
            yield* Queue.end(queue);
          }),
      },
      remoteId,
    );

    click(fixture, 'install');
    Queue.offerUnsafe(queue, { _tag: 'installingAdapter', startedAt: Date.now() });
    await waitForText(fixture, 'Installing Claude…');
    expect(byTestId(fixture, 'cancel-install')?.textContent?.trim()).toBe('Cancel');

    click(fixture, 'cancel-install');
    await waitForText(fixture, "Claude isn't installed.");
    expect(cancelled).toEqual([{ agentId: claude.id, device: remoteId }]);
    expect(byTestId(fixture, 'install')).not.toBeNull();
    expect(byTestId(fixture, 'install-failure')).toBeNull();
  });

  it('survives unmount/remount while installing and keeps original startedAt elapsed timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const startedAt = Date.now();
    const queue = Effect.runSync(Queue.unbounded<InstallEvent, Cause.Done>());
    let cancelCount = 0;

    @Component({
      selector: 'app-toggle-host',
      imports: [AgentInstallOffer],
      changeDetection: ChangeDetectionStrategy.OnPush,
      template: `
        @if (shown()) {
          <app-agent-install [agent]="agent" (installed)="onInstalled()" />
        }
      `,
    })
    class ToggleHost {
      readonly shown = signal(true);
      readonly agent = claude;
      installedCount = 0;
      onInstalled(): void {
        this.installedCount += 1;
      }
    }

    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(
            handlers({
              events: () => Stream.fromQueue(queue),
              onCancel: () => {
                cancelCount += 1;
              },
            }),
          ),
        },
      ],
    });
    const host = TestBed.createComponent(ToggleHost);
    host.detectChanges();

    click(host, 'install');
    Queue.offerUnsafe(queue, { _tag: 'downloadingRuntime', startedAt });
    await waitForText(host, 'Downloading runtime…');

    // Navigate away (unmount AgentInstallOffer).
    host.componentInstance.shown.set(false);
    host.detectChanges();
    expect(byTestId(host, 'agent-install')).toBeNull();
    expect(cancelCount).toBe(0);

    // Advance 12s while unmounted, and move to installingAdapter phase.
    vi.advanceTimersByTime(12_000);
    Queue.offerUnsafe(queue, { _tag: 'installingAdapter', startedAt });

    // Re-open view: reattaches seamlessly with live phase and original elapsed timer (12 s).
    host.componentInstance.shown.set(true);
    host.detectChanges();
    await waitForText(host, 'Installing Claude…');
    await waitForText(host, '12 s');

    Queue.offerUnsafe(queue, { _tag: 'succeeded' });
    Effect.runSync(Queue.end(queue));
    await vi.waitFor(() => expect(host.componentInstance.installedCount).toBe(1));
    expect(text(host)).toContain('Claude is installed.');
    host.destroy();
  });

  it('reattaches on mount via Agents.installStatus when an active setup job is already running in main', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const startedAt = Date.now() - 14_000;
    const queue = Effect.runSync(Queue.unbounded<InstallEvent, Cause.Done>());
    Queue.offerUnsafe(queue, { _tag: 'downloadingRuntime', startedAt });

    const fixture = mount({
      installStatus: () => ({
        _tag: 'installing',
        phase: 'downloadingRuntime',
        startedAt,
      }),
      events: () => Stream.fromQueue(queue),
    });

    await waitForText(fixture, 'Downloading runtime…');
    await waitForText(fixture, '14 s');

    const installed = vi.fn();
    fixture.componentInstance.installed.subscribe(installed);
    Queue.offerUnsafe(queue, { _tag: 'installingAdapter', startedAt });
    await waitForText(fixture, 'Installing Claude…');

    Queue.offerUnsafe(queue, { _tag: 'succeeded' });
    Effect.runSync(Queue.end(queue));
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    fixture.destroy();
  });

  it('offers one-click Update for outdated (unverified) npm Agents with phased progress and emits installed', async () => {
    const outdated: Agent = {
      ...claude,
      installed: true,
      installedVersion: '0.105.0',
      versionQualification: 'unverified',
      upgradeCommand: '@agentclientprotocol/claude-agent-acp@0.106.0',
    };
    const fixture = mount({
      agent: outdated,
      events: Stream.make({ _tag: 'installingAdapter' }, { _tag: 'succeeded' }),
    });
    expect(byTestId(fixture, 'install')).toBeNull();
    expect(byTestId(fixture, 'update-agent')?.textContent?.trim()).toBe('Update');
    expect(text(fixture)).not.toContain("Claude isn't installed.");

    const installed = vi.fn();
    fixture.componentInstance.installed.subscribe(installed);
    click(fixture, 'update-agent');
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    expect(text(fixture)).toContain('Claude is updated.');
  });

  it('supports inline Cancel and mount reattachment in Update mode', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const startedAt = Date.now() - 11_000;
    const outdated: Agent = {
      ...claude,
      installed: true,
      installedVersion: '0.105.0',
      versionQualification: 'unverified',
    };
    const queue = Effect.runSync(Queue.unbounded<InstallEvent, Cause.Done>());
    Queue.offerUnsafe(queue, { _tag: 'installingAdapter', startedAt });
    let cancelled = 0;

    const fixture = mount({
      agent: outdated,
      installStatus: () => ({
        _tag: 'installing',
        phase: 'installingAdapter',
        startedAt,
      }),
      events: () => Stream.fromQueue(queue),
      onCancel: () =>
        Effect.gen(function* () {
          cancelled += 1;
          yield* Queue.offer(queue, { _tag: 'cancelled' });
          yield* Queue.end(queue);
        }),
    });

    await waitForText(fixture, 'Updating Claude…');
    await waitForText(fixture, '11 s');
    expect(byTestId(fixture, 'cancel-install')?.textContent?.trim()).toBe('Cancel');

    click(fixture, 'cancel-install');
    await vi.waitFor(() => expect(cancelled).toBe(1));
    await vi.waitFor(() => expect(byTestId(fixture, 'update-agent')).not.toBeNull());
    fixture.destroy();
  });

  it('shows Updating <Agent>… during installingAdapter in Update mode, Try again, and hides Open log on Remote', async () => {
    const outdated: Agent = {
      ...claude,
      installed: true,
      installedVersion: '0.105.0',
      versionQualification: 'unverified',
    };
    const remoteId = DeviceId.make('dev-studio');
    const headersSeen: Array<string | undefined> = [];
    let attempt = 0;
    const fixture = mountOnDevice(
      {
        agent: outdated,
        headersSeen,
        events: () => {
          attempt += 1;
          return attempt === 1
            ? Stream.make(
                { _tag: 'installingAdapter' as const },
                {
                  _tag: 'failed' as const,
                  reason: 'NpmFailed' as const,
                  detail: 'E404',
                  logPath: '/remote/install.log',
                },
              )
            : Stream.make({ _tag: 'installingAdapter' as const }, { _tag: 'succeeded' as const });
        },
      },
      remoteId,
    );

    click(fixture, 'update-agent');
    await waitForText(fixture, "Couldn't update Claude.");
    expect(headersSeen).toContain(remoteId);
    expect(byTestId(fixture, 'open-log')).toBeNull();
    expect(byTestId(fixture, 'retry-install')).not.toBeNull();

    click(fixture, 'retry-install');
    await waitForText(fixture, 'Claude is updated.');
  });

  it('routes Agents.rescan with DeviceScope header when targeting a Remote device', async () => {
    const remoteId = DeviceId.make('dev-studio');
    const rescanCalls: Array<string | undefined> = [];
    const nativeAgent: Agent = {
      ...claude,
      id: AgentId.make('antigravity'),
      name: 'Antigravity',
      installKind: 'native',
      package: '',
      installInstructions: 'Install Antigravity.',
    };
    const fixture = mountOnDevice(
      {
        events: Stream.empty,
        agent: nativeAgent,
        rescanInstalled: () => true,
        rescanCalls,
      },
      remoteId,
    );
    click(fixture, 'rescan-agents');
    await vi.waitFor(() => expect(rescanCalls).toEqual([remoteId]));
  });

  it('does not retain a stale installed job entry when setup completes while no view is mounted', async () => {
    const queue = Effect.runSync(Queue.unbounded<InstallEvent, Cause.Done>());
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(handlers({ events: () => Stream.fromQueue(queue) })),
        },
      ],
    });
    const tracker = TestBed.inject(AgentInstallTracker);
    tracker.start(claude, undefined);
    expect(tracker.stateFor(undefined, claude.id)?.status).toBe('installing');

    Queue.offerUnsafe(queue, { _tag: 'succeeded' });
    Effect.runSync(Queue.end(queue));
    await vi.waitFor(() => expect(tracker.stateFor(undefined, claude.id)).toBeUndefined());
  });

  it('renders Spanish (es) copy for shared installFailureMessage in AgentInstallOffer', async () => {
    loadTranslations({
      '2722192208079175905': 'No se pudo descargar el entorno de ejecución de Node para {$name}.',
      '6350915110214870672': 'El entorno de ejecución de Node descargado no pasó la verificación.',
      '6514932316653351062': 'Spence no tiene permiso para escribir en su carpeta de agentes.',
      '1098987648044195830': 'No se pudo actualizar {$name}.',
      '3994661888082075472': 'No se pudo instalar {$name}.',
      '1264162568050633999': '{$name} no se encontró en PATH.',
      '2786455332199171608': 'No se pudo iniciar la actualización.',
      '2886102440747920000': 'No se pudo iniciar la configuración.',
    });

    expect(installFailureMessage('RuntimeDownloadFailed', 'Claude', false)).toBe(
      'No se pudo descargar el entorno de ejecución de Node para Claude.',
    );
    expect(installFailureMessage('ChecksumMismatch', 'Claude', false)).toBe(
      'El entorno de ejecución de Node descargado no pasó la verificación.',
    );
    expect(installFailureMessage('PermissionDenied', 'Claude', false)).toBe(
      'Spence no tiene permiso para escribir en su carpeta de agentes.',
    );
    expect(installFailureMessage('NpmFailed', 'Claude', false)).toBe('No se pudo instalar Claude.');
    expect(installFailureMessage('NpmFailed', 'Claude', true)).toBe(
      'No se pudo actualizar Claude.',
    );
    expect(installFailureMessage('NotOnPath', 'Antigravity', false)).toBe(
      'Antigravity no se encontró en PATH.',
    );
    expect(installFailureMessage('Unreachable', 'Claude', false)).toBe(
      'No se pudo iniciar la configuración.',
    );
    expect(installFailureMessage('Unreachable', 'Claude', true)).toBe(
      'No se pudo iniciar la actualización.',
    );

    const fixture = mount({
      events: Stream.make({
        _tag: 'failed',
        reason: 'NpmFailed',
        detail: 'E404',
        logPath: '/tmp/install.log',
      }),
    });
    click(fixture, 'install');
    await waitForText(fixture, 'No se pudo instalar Claude.');
  });
});
