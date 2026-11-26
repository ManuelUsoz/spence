import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChildren,
  type ElementRef,
} from '@angular/core';
import { HlmInputImports } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { toast } from '@ui/toast';
import type { DeviceId } from '../../../../shared/devices/devices.rpc';
import type { PermissionMode, ProjectId } from '../../../../shared/projects/projects.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { onDevice } from '../../../core/device-scope';
import { EffectRuntime } from '../../../core/effect-runtime';
import { RemoteDevices } from '../../../core/remote-devices';
import { ProjectsState } from '../projects-state';
import { SettingsState } from '../settings-state';
import { SettingsStore } from './settings-store';

const getDefault = (device: DeviceId | undefined) =>
  DesktopApi.use((api) => api['ExecutionSettings.get']()).pipe(onDevice(device));

const setMode = (id: ProjectId, mode: PermissionMode | null, device: DeviceId | undefined) =>
  DesktopApi.use((api) =>
    api['Projects.setSettings']({ id, patch: { defaultPermissionMode: mode } }),
  ).pipe(onDevice(device));

const setSetupCommand = (
  id: ProjectId,
  worktreeSetupCommand: string | null,
  device: DeviceId | undefined,
) =>
  DesktopApi.use((api) =>
    api['Projects.setSettings']({ id, patch: { worktreeSetupCommand } }),
  ).pipe(onDevice(device));

const setTargetRemote = (
  id: ProjectId,
  targetRemote: string | null,
  device: DeviceId | undefined,
) =>
  DesktopApi.use((api) => api['Projects.setSettings']({ id, patch: { targetRemote } })).pipe(
    onDevice(device),
  );

@Component({
  selector: 'app-settings-projects',
  imports: [HlmInputImports, HlmSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Projects</h2>
    @if (rows().length > 0) {
      <p class="text-muted-foreground mb-3 text-xs" i18n>Default permission mode</p>
      <ul>
        @for (row of rows(); track row.project.id) {
          @let project = row.project;
          @let inherited = defaults().get(project.device);
          @let pending = state.savingProjectMode();
          @let selection =
            (pending?.id === project.id ? pending?.mode : project.settings.defaultPermissionMode) ??
            'inherit';
          <li
            #projectRow
            class="border-border/60 flex scroll-mt-6 flex-col gap-3 border-t py-3"
            data-testid="settings-project-row"
            [attr.data-project-id]="project.id"
          >
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0">
                <label class="block text-sm break-words" [for]="'project-mode-' + project.id">
                  {{ project.name }}
                  <span class="sr-only" i18n>Default permission mode</span>
                </label>
                @if (row.duplicate) {
                  <p class="text-muted-foreground font-mono text-xs break-all">
                    {{ project.path }}
                  </p>
                }
                @if (row.deviceName; as name) {
                  <p class="text-muted-foreground text-xs" data-testid="project-settings-device">
                    {{ name }}
                  </p>
                }
              </div>
              @if (inherited === undefined) {
                <span
                  class="text-muted-foreground text-xs"
                  data-testid="project-settings-loading"
                  i18n
                  >Loading…</span
                >
              } @else if (inherited === 'failed') {
                <span class="text-destructive text-xs" data-testid="project-settings-failed" i18n
                  >Could not load Settings.</span
                >
              } @else {
                <hlm-select
                  class="shrink-0"
                  data-testid="project-permission"
                  [value]="selection"
                  [disabled]="pending !== null"
                  (valueChange)="change(project.id, project.device, selection, $event)"
                >
                  <hlm-select-trigger [buttonId]="'project-mode-' + project.id">
                    @switch (selection) {
                      @case ('ask') {
                        <span i18n>Ask</span>
                      }
                      @case ('auto') {
                        <span i18n>Auto</span>
                      }
                      @default {
                        <span>{{ inheritedLabel(inherited) }}</span>
                      }
                    }
                  </hlm-select-trigger>
                  <hlm-select-content *hlmSelectPortal>
                    <hlm-select-item value="inherit" data-testid="project-mode-inherit">{{
                      inheritedLabel(inherited)
                    }}</hlm-select-item>
                    <hlm-select-item value="ask" data-testid="project-mode-ask" i18n
                      >Ask</hlm-select-item
                    >
                    <hlm-select-item value="auto" data-testid="project-mode-auto" i18n
                      >Auto</hlm-select-item
                    >
                  </hlm-select-content>
                </hlm-select>
              }
            </div>
            <div class="flex flex-col gap-1">
              <label
                class="text-muted-foreground text-xs"
                [for]="'project-setup-' + project.id"
                i18n
              >
                Worktree setup command
              </label>
              <input
                #setupInput
                hlmInput
                [id]="'project-setup-' + project.id"
                class="h-8 font-mono text-xs"
                data-testid="project-worktree-setup"
                placeholder="Auto-detect (e.g. npm ci, mvn test-compile)"
                i18n-placeholder
                [value]="project.settings.worktreeSetupCommand ?? ''"
                (blur)="
                  changeSetupCommand(
                    project.id,
                    project.device,
                    project.settings.worktreeSetupCommand ?? '',
                    setupInput.value
                  )
                "
                (keydown.enter)="setupInput.blur()"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label
                class="text-muted-foreground text-xs"
                [for]="'project-target-remote-' + project.id"
                i18n
              >
                Pull request target remote
              </label>
              <input
                #targetRemoteInput
                hlmInput
                [id]="'project-target-remote-' + project.id"
                class="h-8 font-mono text-xs"
                data-testid="project-target-remote"
                placeholder="Auto (upstream → origin)"
                i18n-placeholder
                [value]="project.settings.targetRemote ?? ''"
                (blur)="
                  changeTargetRemote(
                    project.id,
                    project.device,
                    project.settings.targetRemote ?? '',
                    targetRemoteInput.value
                  )
                "
                (keydown.enter)="targetRemoteInput.blur()"
              />
            </div>
          </li>
        }
      </ul>
    } @else if (projects.state().status === 'loading') {
      <p class="text-muted-foreground py-3 text-sm" i18n>Loading…</p>
    } @else if (projects.state().status === 'failed') {
      <p class="text-destructive py-3 text-sm" i18n>Could not load Projects.</p>
    } @else {
      <p class="text-muted-foreground py-3 text-sm" i18n>No Projects yet.</p>
    }
  `,
})
export class SettingsProjects {
  protected readonly state = inject(SettingsState);
  protected readonly projects = inject(ProjectsState);
  private readonly store = inject(SettingsStore, { optional: true });
  private readonly devices = inject(RemoteDevices);
  private readonly runtime = inject(EffectRuntime);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly projectRows = viewChildren<ElementRef<HTMLElement>>('projectRow');

  protected readonly rows = computed(() => {
    const projects = this.projects.ordered();
    const counts = new Map<string, number>();
    for (const project of projects) {
      const name = project.name.toLocaleLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return projects.map((project) => ({
      project,
      duplicate: (counts.get(project.name.toLocaleLowerCase()) ?? 0) > 1,
      deviceName: project.device === undefined ? null : this.devices.nameOf(project.device),
    }));
  });

  protected readonly defaults = signal<
    ReadonlyMap<DeviceId | undefined, PermissionMode | 'failed'>
  >(new Map());

  constructor() {
    effect((onCleanup) => {
      const devices = [undefined, ...this.devices.online().map((device) => device.id)];
      // Refresh inherited labels after a Sessions setting changes.
      this.store?.executionLoaded();
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      for (const device of devices) {
        void this.runtime.run(getDefault(device), { signal: controller.signal }).then((exit) => {
          if (controller.signal.aborted) return;
          const mode = exit._tag === 'Success' ? exit.value.defaultPermissionMode : 'failed';
          this.defaults.update((current) => new Map(current).set(device, mode));
        });
      }
    });
    afterRenderEffect({
      write: () => {
        const id = this.state.projectId();
        if (id === null) return;
        const row = this.projectRows().find(
          (entry) => entry.nativeElement.dataset['projectId'] === id,
        );
        if (row === undefined) return;
        row.nativeElement.scrollIntoView?.({ block: 'start' });
        this.state.projectId.set(null);
      },
    });
  }

  protected inheritedLabel(mode: PermissionMode): string {
    return mode === 'ask'
      ? $localize`Use global default (Ask)`
      : $localize`Use global default (Auto)`;
  }

  protected async change(
    id: ProjectId,
    device: DeviceId | undefined,
    current: PermissionMode | 'inherit',
    value: unknown,
  ): Promise<void> {
    if (this.state.savingProjectMode() !== null || value === current) return;
    if (value !== 'inherit' && value !== 'ask' && value !== 'auto') return;
    const mode = value === 'inherit' ? null : value;
    this.state.savingProjectMode.set({ id, mode });
    // Apply the pending value before the RPC so a fast failure also resets Helm's selection.
    this.changeDetector.detectChanges();
    try {
      const exit = await this.runtime.run(setMode(id, mode, device));
      if (exit._tag === 'Success') this.projects.changed(exit.value);
      else toast.error($localize`Could not change the Project settings.`);
    } finally {
      this.state.savingProjectMode.set(null);
    }
  }

  protected async changeSetupCommand(
    id: ProjectId,
    device: DeviceId | undefined,
    current: string,
    rawValue: string,
  ): Promise<void> {
    const trimmed = rawValue.trim();
    if (trimmed === current.trim()) return;
    const command = trimmed.length === 0 ? null : trimmed;
    const exit = await this.runtime.run(setSetupCommand(id, command, device));
    if (exit._tag === 'Success') this.projects.changed(exit.value);
    else toast.error($localize`Could not change the Project settings.`);
  }

  protected async changeTargetRemote(
    id: ProjectId,
    device: DeviceId | undefined,
    current: string,
    rawValue: string,
  ): Promise<void> {
    const trimmed = rawValue.trim();
    if (trimmed === current.trim()) return;
    const targetRemote = trimmed.length === 0 ? null : trimmed;
    const exit = await this.runtime.run(setTargetRemote(id, targetRemote, device));
    if (exit._tag === 'Success') this.projects.changed(exit.value);
    else toast.error($localize`Could not change the Project settings.`);
  }
}
