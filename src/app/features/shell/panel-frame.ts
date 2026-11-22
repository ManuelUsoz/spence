import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { PaneId, TabId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { DeviceScopeDirective } from '../../core/device-scope.directive';
import { PanelRegistry, type PanelRenderContext } from '../../core/panel-registry';
import { Tabs } from '../../core/tabs';
import { PanelHeader } from './panel-header';
import { ProjectsState } from './projects-state';

/**
 * Renders one Panel: an optional full-Pane Session wallpaper + scrim, a borderless floating
 * `PanelHeader`, and the Panel body component resolved from `PanelRegistry` via `NgComponentOutlet`.
 */
@Component({
  selector: 'app-panel-frame',
  imports: [DeviceScopeDirective, NgComponentOutlet, PanelHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'group/pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    'data-testid': 'panel-frame',
    '[attr.data-panel-id]': 'panel().id',
    '[attr.data-panel-kind]': 'panel().spec._tag',
    '[attr.data-focused]': "focused() ? 'true' : 'false'",
    '(mousedown)': 'onFocusRequest()',
    '(focusin)': 'onFocusRequest()',
  },
  template: `
    @if (wallpaper(); as wp) {
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 z-0 overflow-hidden"
        data-testid="session-wallpaper"
        [attr.data-wallpaper-id]="wp.id"
      >
        <img [src]="wp.url" alt="" class="h-full w-full object-cover" />
        <div class="session-wallpaper-scrim absolute inset-0"></div>
      </div>
    }
    <app-panel-header
      class="absolute inset-x-0 top-0 z-20"
      [class.pointer-events-none]="!isSplit()"
      [tabId]="tabId()"
      [panel]="panel()"
      [paneId]="paneId()"
      [projectId]="projectId()"
      [projectName]="projectName()"
      [focused]="focused()"
      [canSplit]="canSplit()"
      [isSplit]="isSplit()"
    />
    <div
      class="relative z-10 min-h-0 flex-1 overflow-y-auto pt-12 pb-4"
      [class.px-6]="panel().spec._tag !== 'Session'"
      [appDeviceScope]="device()"
      data-testid="panel-body"
    >
      @if (definition(); as def) {
        <ng-container *ngComponentOutlet="def.component; inputs: componentInputs()" />
      }
    </div>
  `,
})
export class PanelFrame {
  private readonly registry = inject(PanelRegistry);
  private readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);

  readonly tabId = input<TabId | null>(null);
  readonly panel = input.required<WorkspacePanel>();
  readonly paneId = input<PaneId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
  readonly canSplit = input(true);
  readonly isSplit = input(false);

  protected readonly wallpaper = computed(() => this.tabs.panelWallpaper(this.panel()));
  protected readonly device = computed(
    () => this.tabs.projectDevice(this.projectId()) ?? this.projects.deviceOf(this.projectId()),
  );
  protected readonly definition = computed(() => this.registry.get(this.panel().spec._tag));

  protected readonly componentInputs = computed((): Readonly<Record<string, unknown>> => {
    const context: PanelRenderContext = {
      panel: this.panel(),
      paneId: this.paneId(),
      projectId: this.projectId(),
      projectName: this.projectName(),
      focused: this.focused(),
    };
    const def = this.definition();
    if (def?.inputs !== undefined) return def.inputs(context);
    return {
      panel: context.panel,
      projectId: context.projectId,
      projectName: context.projectName,
      focused: context.focused,
    };
  });

  protected onFocusRequest(): void {
    if (!this.focused()) {
      this.tabs.focusPanel(this.panel().id);
    }
  }
}
