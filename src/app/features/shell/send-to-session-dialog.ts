import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Cause, Effect, Exit, Option } from 'effect';
import { HlmButtonImports } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmTextareaImports } from '@ui/textarea';
import type { DeviceId } from '../../../shared/devices/devices.rpc';
import type { MessagingError, SendingSession } from '../../../shared/messaging/messaging.rpc';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId, SessionSummary } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { onDevice } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';
import { Keymap } from '../../core/keymap';
import { RemoteDevices } from '../../core/remote-devices';
import { titleOf } from '../../core/tabs';
import { ProjectsState } from './projects-state';
import { SendToSession } from './send-to-session';

/** Where the Message goes: an existing Session, or a new one in a Project. `device` is absent for the Local one. */
type Target =
  | {
      readonly kind: 'session';
      readonly device: DeviceId | undefined;
      readonly sessionId: SessionId;
      readonly title: string;
    }
  | {
      readonly kind: 'new';
      readonly device: DeviceId | undefined;
      readonly projectId: ProjectId;
      readonly projectName: string;
    };

type Summary =
  | { readonly status: 'off' }
  | { readonly status: 'preparing' }
  | { readonly status: 'ready'; readonly text: string }
  | { readonly status: 'failed' };

/** One Project in the picker with its Sessions, once loaded. */
interface PickerProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly sessions: ReadonlyArray<{ readonly id: SessionId; readonly title: string }>;
}

/** One Device in the picker: the Local one, a connected Remote one, or an offline Paired one (nothing to pick). */
interface PickerDevice {
  readonly key: string;
  readonly device: DeviceId | undefined;
  readonly name: string | null;
  readonly online: boolean;
  readonly projects: ReadonlyArray<PickerProject>;
}

const keyOf = (device: DeviceId | undefined, project: ProjectId): string =>
  `${device ?? 'local'}/${project}`;

const listSessions = (device: DeviceId | undefined, projectId: ProjectId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Session.list']({ projectId });
  }).pipe(onDevice(device));

const localName = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return (yield* api['Devices.local']()).name;
});

const prepareSummary = (from: SendingSession) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return (yield* api['Session.prepareHandoff']({ sessionId: from.sessionId, kind: 'fork' }))
      .summary;
  }).pipe(onDevice(from.device));

const send = Effect.fnUntraced(function* (
  from: SendingSession,
  target: Target,
  text: string,
  summary: string | undefined,
) {
  const api = yield* DesktopApi;
  const device = target.device === undefined ? {} : { device: target.device };
  if (target.kind === 'session') {
    yield* api['Messaging.send']({ from, ...device, sessionId: target.sessionId, text });
  } else {
    yield* api['Messaging.startSession']({
      from,
      ...device,
      projectId: target.projectId,
      text,
      ...(summary === undefined ? {} : { summary }),
    });
  }
});

/** What a refused send means, in the user's words. */
const refusal = (error: MessagingError): string => {
  switch (error.reason) {
    case 'Offline':
      return $localize`That Device is offline. Nothing was sent.`;
    case 'Busy':
      return $localize`That Session cannot take a Message right now. Nothing was sent.`;
    case 'NotFound':
      return $localize`That Session or Project is gone. Nothing was sent.`;
    case 'Forbidden':
      return $localize`That Session does not accept Messages. Nothing was sent.`;
    case 'Loop':
      return $localize`That Message would come back to where it came from. Nothing was sent.`;
    case 'Unavailable':
      return $localize`The Agent on that Device cannot start. Nothing was sent.`;
  }
};

/**
 * Send to another Session…: a person's Message to any Session on any Device (this one included), or a new Session in
 * a Project with that first Message, optionally seeded by a reviewed Summary of the open Session. Offline Devices
 * are listed but cannot be picked; the receiving Session will show the Provenance previewed here.
 */
@Component({
  selector: 'app-send-to-session-dialog',
  imports: [HlmButtonImports, HlmDialogImports, HlmTextareaImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog
      [state]="from() === null ? 'closed' : 'open'"
      (stateChanged)="onStateChange($event)"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="sm:max-w-lg"
        data-testid="send-to-session-dialog"
        closeLabel="Close"
        i18n-closeLabel
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle i18n>Send to another Session</h2>
        </hlm-dialog-header>
        <div
          class="border-border flex max-h-64 flex-col gap-3 overflow-y-auto rounded-lg border p-2"
          role="listbox"
          aria-label="Target"
          i18n-aria-label
          data-testid="send-targets"
        >
          @for (group of devices(); track group.key) {
            <div class="flex flex-col gap-0.5" data-testid="send-device">
              <div
                class="text-muted-foreground flex items-center gap-1.5 px-1.5 text-xs font-medium"
              >
                <span
                  aria-hidden="true"
                  class="size-1.5 shrink-0 rounded-full"
                  [class.bg-online]="group.online"
                  [class.bg-muted-foreground]="!group.online"
                ></span>
                @if (group.name; as name) {
                  <span class="truncate" data-testid="send-device-name">{{ name }}</span>
                } @else {
                  <span class="truncate" data-testid="send-device-name" i18n>This Device</span>
                }
                @if (!group.online) {
                  <span class="ml-auto" data-testid="send-device-offline" i18n>Offline</span>
                }
              </div>
              @if (!group.online) {
                <button
                  type="button"
                  role="option"
                  disabled
                  aria-disabled="true"
                  class="text-muted-foreground/60 h-7 rounded-md px-2 text-left text-sm"
                  data-testid="send-target-offline"
                  i18n
                >
                  Not connected
                </button>
              }
              @for (project of group.projects; track project.id) {
                <div class="text-muted-foreground mt-1 truncate px-2 text-xs">
                  {{ project.name }}
                </div>
                @for (session of project.sessions; track session.id) {
                  <button
                    type="button"
                    role="option"
                    class="hover:bg-accent aria-selected:bg-accent focus-visible:ring-ring h-7 truncate rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2"
                    data-testid="send-target-session"
                    [attr.aria-selected]="isSession(group.device, session.id)"
                    (click)="pickSession(group.device, session.id, session.title)"
                  >
                    {{ session.title }}
                  </button>
                }
                <button
                  type="button"
                  role="option"
                  class="hover:bg-accent aria-selected:bg-accent focus-visible:ring-ring text-muted-foreground h-7 truncate rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2"
                  data-testid="send-target-new"
                  [attr.aria-selected]="isNew(group.device, project.id)"
                  (click)="pickNew(group.device, project.id, project.name)"
                  i18n
                >
                  Start a new Session in {{ project.name }}
                </button>
              }
            </div>
          }
        </div>
        <textarea
          hlmTextarea
          class="min-h-20"
          data-testid="send-text"
          placeholder="Message"
          i18n-placeholder
          [value]="text()"
          (input)="text.set($any($event.target).value)"
        ></textarea>
        @if (target()?.kind === 'new') {
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="send-seed"
              [checked]="summary().status !== 'off'"
              (change)="toggleSeed($any($event.target).checked)"
            />
            <span i18n>Seed it with a Summary of this Session</span>
          </label>
          @switch (summary().status) {
            @case ('preparing') {
              <p class="text-muted-foreground text-xs" data-testid="send-summary-preparing" i18n>
                Preparing the Summary…
              </p>
            }
            @case ('failed') {
              <p class="text-destructive text-xs" i18n>The Summary could not be prepared.</p>
            }
            @case ('ready') {
              <textarea
                hlmTextarea
                class="min-h-24 text-xs"
                data-testid="send-summary"
                aria-label="Summary"
                i18n-aria-label
                [value]="summaryText()"
                (input)="editSummary($any($event.target).value)"
              ></textarea>
            }
          }
        }
        @if (from(); as sender) {
          <p class="text-muted-foreground text-xs" data-testid="send-provenance-preview">
            <span i18n
              >They will see: From you · {{ localDevice() }} · {{ sender.title }} in
              {{ sender.projectName }}</span
            >
          </p>
        }
        @if (error(); as message) {
          <p class="text-destructive text-sm" role="alert" data-testid="send-error">
            {{ message }}
          </p>
        }
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" type="button" (click)="close()" i18n>Cancel</button>
          <button
            hlmBtn
            type="button"
            data-testid="send-submit"
            [disabled]="!canSend()"
            (click)="submit()"
            i18n
          >
            Send
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class SendToSessionDialog {
  private readonly runtime = inject(EffectRuntime);
  private readonly state = inject(SendToSession);
  private readonly projects = inject(ProjectsState);
  private readonly remote = inject(RemoteDevices);
  private readonly keymap = inject(Keymap);

  protected readonly from = this.state.from;
  protected readonly text = signal('');
  protected readonly target = signal<Target | null>(null);
  protected readonly summary = signal<Summary>({ status: 'off' });
  protected readonly error = signal<string | null>(null);
  protected readonly sending = signal(false);
  protected readonly localDevice = signal('');
  private readonly sessions = signal<
    ReadonlyMap<string, ReadonlyArray<{ readonly id: SessionId; readonly title: string }>>
  >(new Map());
  private summaryEdit: string | null = null;
  /** The Projects whose Sessions were asked for since the dialog opened. */
  private readonly requested = new Set<string>();

  protected readonly devices = computed((): ReadonlyArray<PickerDevice> => {
    const loaded = this.sessions();
    const from = this.from();
    const reachable = this.projects.groups().map((group): PickerDevice => ({
      key: group.device ?? 'local',
      device: group.device,
      name: group.name,
      online: true,
      projects: group.projects.map((project) => ({
        id: project.id,
        name: project.name,
        sessions: (loaded.get(keyOf(group.device, project.id)) ?? []).filter(
          (session) => session.id !== from?.sessionId,
        ),
      })),
    }));
    const offline = this.remote
      .connections()
      .filter((connection) => connection.status._tag !== 'Online')
      .map((connection): PickerDevice => ({
        key: connection.id,
        device: connection.id,
        name: connection.name,
        online: false,
        projects: [],
      }));
    return [...reachable, ...offline];
  });

  protected readonly summaryText = computed(() => {
    const summary = this.summary();
    return summary.status === 'ready' ? summary.text : '';
  });

  protected readonly canSend = computed(
    () =>
      this.target() !== null &&
      this.text().trim() !== '' &&
      !this.sending() &&
      this.summary().status !== 'preparing',
  );

  constructor() {
    effect((onCleanup) => {
      if (this.from() === null) return;
      untracked(() => this.reset());
      const release = this.keymap.pushModal({ onEscape: () => this.close() });
      onCleanup(release);
    });
    // Each Project's Sessions are listed once per opening, as its Device's Projects arrive.
    effect(() => {
      if (this.from() === null) return;
      const groups = this.projects.groups();
      untracked(() => {
        for (const group of groups) {
          for (const project of group.projects) this.listOnce(group.device, project.id);
        }
      });
    });
  }

  private reset(): void {
    this.requested.clear();
    this.sessions.set(new Map());
    this.text.set('');
    this.target.set(null);
    this.summary.set({ status: 'off' });
    this.error.set(null);
    this.summaryEdit = null;
    void this.runtime.run(localName).then((exit) => {
      if (Exit.isSuccess(exit)) this.localDevice.set(exit.value);
    });
  }

  private listOnce(device: DeviceId | undefined, projectId: ProjectId): void {
    const key = keyOf(device, projectId);
    if (this.requested.has(key)) return;
    this.requested.add(key);
    void this.runtime.run(listSessions(device, projectId)).then((exit) => {
      if (Exit.isFailure(exit) || !this.requested.has(key)) return;
      const sessions = exit.value
        .filter((session: SessionSummary) => session.archivedAt === undefined)
        .map((session) => ({
          id: session.id,
          title: titleOf(session.title) ?? $localize`New Session`,
        }));
      this.sessions.update((all) => new Map(all).set(key, sessions));
    });
  }

  protected isSession(device: DeviceId | undefined, id: SessionId): boolean {
    const target = this.target();
    return target?.kind === 'session' && target.device === device && target.sessionId === id;
  }

  protected isNew(device: DeviceId | undefined, id: ProjectId): boolean {
    const target = this.target();
    return target?.kind === 'new' && target.device === device && target.projectId === id;
  }

  protected pickSession(device: DeviceId | undefined, sessionId: SessionId, title: string): void {
    this.target.set({ kind: 'session', device, sessionId, title });
    this.error.set(null);
  }

  protected pickNew(device: DeviceId | undefined, projectId: ProjectId, projectName: string): void {
    this.target.set({ kind: 'new', device, projectId, projectName });
    this.error.set(null);
  }

  protected toggleSeed(on: boolean): void {
    const from = this.from();
    if (!on || from === null) {
      this.summary.set({ status: 'off' });
      return;
    }
    this.summary.set({ status: 'preparing' });
    void this.runtime.run(prepareSummary(from)).then((exit) => {
      if (this.summary().status !== 'preparing') return;
      this.summaryEdit = null;
      this.summary.set(
        Exit.isSuccess(exit) ? { status: 'ready', text: exit.value } : { status: 'failed' },
      );
    });
  }

  protected editSummary(text: string): void {
    this.summaryEdit = text;
  }

  protected async submit(): Promise<void> {
    const from = this.from();
    const target = this.target();
    if (from === null || target === null || !this.canSend()) return;
    const summary = this.summary();
    const seed =
      target.kind === 'new' && summary.status === 'ready'
        ? (this.summaryEdit ?? summary.text)
        : undefined;
    this.sending.set(true);
    this.error.set(null);
    const exit = await this.runtime.run(send(from, target, this.text().trim(), seed));
    this.sending.set(false);
    if (Exit.isSuccess(exit)) {
      this.close();
      return;
    }
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    this.error.set(
      failure?._tag === 'MessagingError'
        ? refusal(failure)
        : $localize`The Message could not be sent. Nothing was sent.`,
    );
  }

  protected close(): void {
    this.state.close();
  }

  protected onStateChange(next: string): void {
    if (next === 'closed') this.close();
  }
}
