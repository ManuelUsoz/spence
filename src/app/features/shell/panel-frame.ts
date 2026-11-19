import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { PaneId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { PanelRegistry, type PanelRenderContext } from '../../core/panel-registry';
import { Tabs } from '../../core/tabs';
import { PanelHeader } from './panel-header';

/**
 * Renders one Panel: its compact `PanelHeader` and its body component resolved from `PanelRegistry` via
 * `NgComponentOutlet`. Clicking or focusing inside an unfocused Panel updates the Tab's `focusedPanelId`.
 */
@Component({
  selector: 'app-panel-frame',
  imports: [NgComponentOutlet, PanelHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    'data-testid': 'panel-frame',
    '[attr.data-panel-id]': 'panel().id',
    '[attr.data-panel-kind]': 'panel().spec._tag',
    '[attr.data-focused]': "focused() ? 'true' : 'false'",
    '(mousedown)': 'onFocusRequest()',
    '(focusin)': 'onFocusRequest()',
  },
  template: `
    <app-panel-header
      [panel]="panel()"
      [paneId]="paneId()"
      [projectId]="projectId()"
      [projectName]="projectName()"
      [focused]="focused()"
      [canSplit]="canSplit()"
    />
    @if (!panel().collapsed) {
      <div class="min-h-0 flex-1 overflow-y-auto p-6" data-testid="panel-body">
        @if (definition(); as def) {
          <ng-container *ngComponentOutlet="def.component; inputs: componentInputs()" />
        }
      </div>
    }
  `,
})
export class PanelFrame {
  private readonly registry = inject(PanelRegistry);
  private readonly tabs = inject(Tabs);

  readonly panel = input.required<WorkspacePanel>();
  readonly paneId = input<PaneId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
  readonly canSplit = input(true);

  protected readonly definition = computed(() => this.registry.get(this.panel().spec._tag));

  protected readonly componentInputs = computed((): Readonly<Record<string, unknown>> => {
    const context: PanelRenderContext = {
      panel: this.panel(),
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
