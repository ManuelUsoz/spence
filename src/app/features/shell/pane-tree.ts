import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { PaneId, PaneLayout, PaneNode, PanelId, TabId } from '../../../shared/tabs/tabs.rpc';
import { MAX_PANES_PER_TAB, paneCount } from '../../../shared/tabs/workspace-layout';
import { Tabs } from '../../core/tabs';
import { PaneDivider } from './pane-divider';
import { PaneView } from './pane-view';

/**
 * Recursively renders a Tab's binary `PaneLayout`: `SplitPaneNode`s as `flex-row` / `flex-col`
 * regions sized by `ratio` with minimum Pane dimensions and `<app-pane-divider>` separators, and
 * `LeafPaneNode`s as `<app-pane-view>`.
 */
@Component({
  selector: 'app-pane-tree',
  imports: [NgTemplateOutlet, PaneDivider, PaneView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 min-w-0 flex-1 overflow-hidden' },
  template: `
    @if (node(); as current) {
      @switch (current._tag) {
        @case ('Split') {
          @let activeRatio = displayedRatio(current.id, current.ratio);
          <div
            #splitContainer
            class="flex min-h-0 min-w-0 flex-1 overflow-hidden"
            [class.flex-row]="current.direction === 'horizontal'"
            [class.flex-col]="current.direction === 'vertical'"
            data-testid="pane-split"
            [attr.data-split-id]="current.id"
            [attr.data-direction]="current.direction"
          >
            <ng-container
              *ngTemplateOutlet="
                branch;
                context: {
                  $implicit: current.first,
                  name: 'first',
                  ratio: activeRatio,
                  direction: current.direction,
                }
              "
            />
            <app-pane-divider
              [direction]="current.direction"
              [ratio]="activeRatio"
              [container]="splitContainer"
              (ratioPreview)="onRatioPreview(current.id, $event)"
              (ratioCommit)="onRatioCommit(current.id, $event)"
            />
            <ng-container
              *ngTemplateOutlet="
                branch;
                context: {
                  $implicit: current.second,
                  name: 'second',
                  ratio: 1 - activeRatio,
                  direction: current.direction,
                }
              "
            />
          </div>
        }
        @case ('Leaf') {
          <app-pane-view
            [tabId]="tabId()"
            [pane]="current"
            [projectId]="projectId()"
            [projectName]="projectName()"
            [focusedPanelId]="focusedPanelId()"
            [canSplit]="effectiveCanSplit()"
          />
        }
      }
    }

    <ng-template #branch let-branchId let-name="name" let-ratio="ratio" let-direction="direction">
      <div
        [class]="
          direction === 'horizontal'
            ? 'flex min-h-0 min-w-[220px] overflow-hidden'
            : 'flex min-h-[140px] min-w-0 overflow-hidden'
        "
        [style.flex]="flexStyle(ratio)"
        data-testid="pane-branch"
        [attr.data-branch]="name"
      >
        <app-pane-tree
          [tabId]="tabId()"
          [layout]="layout()"
          [nodeId]="branchId"
          [projectId]="projectId()"
          [projectName]="projectName()"
          [focusedPanelId]="focusedPanelId()"
          [canSplit]="effectiveCanSplit()"
        />
      </div>
    </ng-template>
  `,
})
export class PaneTree {
  private readonly tabs = inject(Tabs);

  readonly tabId = input.required<TabId>();
  readonly layout = input.required<PaneLayout>();
  readonly nodeId = input<PaneId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focusedPanelId = input<PanelId | null>(null);
  readonly canSplit = input<boolean | null>(null);

  private readonly preview = signal<{ readonly splitId: PaneId; readonly ratio: number } | null>(
    null,
  );

  private readonly nodeMap = computed(
    (): ReadonlyMap<PaneId, PaneNode> => new Map(this.layout().nodes.map((n) => [n.id, n])),
  );

  protected readonly node = computed((): PaneNode | undefined =>
    this.nodeMap().get(this.nodeId() ?? this.layout().rootPaneId),
  );

  protected readonly effectiveCanSplit = computed((): boolean => {
    const explicit = this.canSplit();
    if (explicit !== null) return explicit;
    return paneCount({ layout: this.layout() }) < MAX_PANES_PER_TAB;
  });

  protected displayedRatio(splitId: PaneId, persisted: number): number {
    const live = this.preview();
    return live !== null && live.splitId === splitId ? live.ratio : persisted;
  }

  protected onRatioPreview(splitId: PaneId, ratio: number | null): void {
    this.preview.set(ratio === null ? null : { splitId, ratio });
  }

  protected onRatioCommit(splitId: PaneId, ratio: number): void {
    this.preview.set(null);
    this.tabs.setSplitRatio(this.tabId(), splitId, ratio);
  }

  protected flexStyle(ratio: number): string {
    return `${ratio} 1 0%`;
  }
}
