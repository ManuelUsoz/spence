import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentId,
  AgentsRpcs,
  type Agent,
  type InstallEvent,
} from '../../../shared/agents/agents.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { AgentInstallOffer } from './agent-install';

const COMMAND = 'npm install -g @agentclientprotocol/claude-agent-acp';

const claude: Agent = {
  id: AgentId.make('claude'),
  name: 'Claude',
  package: '@agentclientprotocol/claude-agent-acp',
  installed: false,
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
};

interface Served {
  readonly npmFound: boolean;
  readonly events: Stream.Stream<InstallEvent>;
}

let logOpened = 0;

const handlers = ({ npmFound, events }: Served) =>
  AgentsRpcs.toLayer({
    'Agents.list': () => Effect.succeed([claude]),
    'Agents.installCommand': () => Effect.succeed({ command: COMMAND, npmFound }),
    'Agents.install': () => events,
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
  fixture.componentRef.setInput('agent', claude);
  return fixture;
};

const text = (fixture: ComponentFixture<AgentInstallOffer>): string => {
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
};

const byTestId = (fixture: ComponentFixture<AgentInstallOffer>, id: string): HTMLElement | null =>
  (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

const click = (fixture: ComponentFixture<AgentInstallOffer>, id: string): void => {
  const button = byTestId(fixture, id);
  if (button === null) throw new Error(`no ${id}`);
  button.click();
  fixture.detectChanges();
};

const waitForText = (fixture: ComponentFixture<AgentInstallOffer>, expected: string) =>
  vi.waitFor(() => expect(text(fixture)).toContain(expected));

const started: InstallEvent = { _tag: 'started' };

beforeEach(() => {
  logOpened = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentInstallOffer', () => {
  it('offers Install and Show command, and shows the exact command before installing', async () => {
    const fixture = mount({
      npmFound: true,
      events: Stream.make(started, { _tag: 'succeeded' }),
    });
    await waitForText(fixture, "Claude isn't installed. Install it?");
    expect(text(fixture)).not.toContain(COMMAND);

    click(fixture, 'show-command');
    expect(byTestId(fixture, 'install-command')?.textContent).toContain(COMMAND);

    const installed = vi.fn();
    fixture.componentInstance.installed.subscribe(installed);
    click(fixture, 'install');
    expect(byTestId(fixture, 'install-command')?.textContent).toContain(COMMAND);
    click(fixture, 'confirm-install');
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    expect(text(fixture)).toContain('Claude is installed.');
  });

  it('shows an indeterminate bar while installing, and the elapsed time after about 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const fixture = mount({
      npmFound: true,
      events: Stream.concat(Stream.make(started), Stream.never),
    });
    await waitForText(fixture, 'Install it?');
    click(fixture, 'install');
    click(fixture, 'confirm-install');
    await waitForText(fixture, 'Installing Claude…');
    expect(byTestId(fixture, 'install-progress')).not.toBeNull();
    expect(byTestId(fixture, 'install-elapsed')).toBeNull();

    vi.advanceTimersByTime(12_000);
    await waitForText(fixture, '12 s');
    expect(byTestId(fixture, 'install-elapsed')).not.toBeNull();
    fixture.destroy();
  });

  it('on failure shows the reason, the command and Open log', async () => {
    const fixture = mount({
      npmFound: true,
      events: Stream.make(started, {
        _tag: 'failed',
        reason: 'PermissionDenied',
        detail: 'Error: EACCES: permission denied',
        logPath: '/data/spence/logs/agents/install.log',
      }),
    });
    await waitForText(fixture, 'Install it?');
    click(fixture, 'install');
    click(fixture, 'confirm-install');
    await waitForText(fixture, "npm isn't allowed to write to its global folder.");
    expect(text(fixture)).toContain('Error: EACCES: permission denied');
    expect(byTestId(fixture, 'install-command')?.textContent).toContain(COMMAND);

    click(fixture, 'open-log');
    await vi.waitFor(() => expect(logOpened).toBe(1));
  });

  it('without npm offers only the command and says Node.js is needed', async () => {
    const fixture = mount({ npmFound: false, events: Stream.empty });
    await waitForText(fixture, 'Node.js');
    expect(byTestId(fixture, 'install-command')?.textContent).toContain(COMMAND);
    expect(byTestId(fixture, 'install')).toBeNull();
  });
});
