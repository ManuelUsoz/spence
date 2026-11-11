// PROTOTYPE (throwaway, branch prototype/project-sidebar): Variant C, "One Project at a time".
// A Project switcher at the top (other Projects' Attention shows as a dot on it), then only that Project's
// Sessions: those calling for Attention pinned under "Needs you", the rest grouped by day, two-line rows.
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HlmSidebarImports } from '@ui/sidebar';
import { SidebarProto, groupByDate, relTime } from './proto-model';
import type { Session } from './proto-model';
import { ProtoIcon, ProtoMarks, ProtoRename, rowClass } from './proto-shared';

@Component({
  selector: 'proto-variant-c',
  imports: [HlmSidebarImports, NgTemplateOutlet, ProtoIcon, ProtoMarks, ProtoRename],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = current();
    <hlm-sidebar collapsible="offcanvas">
      <div class="relative flex h-full flex-col px-2 py-3 text-sm">
        @if (p) {
          <button
            type="button"
            class="hover:bg-sidebar-accent flex h-11 items-center gap-2.5 rounded-lg px-2 text-left"
            [attr.aria-expanded]="picker()"
            (click)="picker.set(!picker())"
            (contextmenu)="proto.openMenu($event, { kind: 'project', id: p.id })"
          >
            <span class="bg-sidebar-primary text-sidebar-primary-foreground flex size-7 items-center justify-center rounded-md text-xs font-semibold uppercase">{{ p.name[0] }}</span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-semibold">{{ p.name }}</span>
              <span class="truncate text-[11px]" [class]="p.folderMissing ? 'text-destructive' : 'text-muted-foreground'">
                {{ p.folderMissing ? 'Folder missing' : p.path }}
              </span>
            </span>
            @if (othersAttention(); as a) {
              <span class="size-2 rounded-full" [class]="a === 'error' ? 'bg-destructive' : 'bg-amber-500'" title="Another Project needs you"></span>
            }
            <proto-icon name="down" [size]="14" class="text-muted-foreground" />
          </button>

          @if (picker()) {
            <div class="fixed inset-0 z-30" (click)="picker.set(false)"></div>
            <div role="menu" class="bg-popover absolute top-[58px] right-2 left-2 z-40 rounded-lg border p-1 shadow-lg">
              @for (q of proto.orderedProjects(); track q.id) {
                <button
                  type="button"
                  role="menuitemradio"
                  [attr.aria-checked]="q.id === p.id"
                  class="hover:bg-accent flex h-8 w-full items-center gap-2 rounded-md px-2 text-left"
                  (click)="pick(q.id)"
                  (contextmenu)="proto.openMenu($event, { kind: 'project', id: q.id })"
                >
                  <span class="min-w-0 flex-1 truncate">{{ q.name }}</span>
                  @if (q.folderMissing) { <proto-icon name="folderX" [size]="14" class="text-destructive" /> }
                  @switch (proto.projectAttention(q.id)) {
                    @case ('answer') { <span class="size-2 rounded-full bg-amber-500"></span> }
                    @case ('error') { <span class="bg-destructive size-2 rounded-full"></span> }
                  }
                  @if (proto.projectRunning(q.id)) {
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="text-muted-foreground"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
                  }
                  <proto-icon name="check" [size]="14" [style.visibility]="q.id === p.id ? 'visible' : 'hidden'" />
                </button>
              }
              <div class="bg-border -mx-1 my-1 h-px"></div>
              <button type="button" class="hover:bg-accent text-muted-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left">
                <proto-icon name="plus" [size]="14" /> Add Project
              </button>
            </div>
          }

          <div class="mt-2 flex gap-1">
            <button type="button" class="hover:bg-sidebar-accent flex h-8 flex-1 items-center gap-2 rounded-md border px-2 text-left" (click)="proto.newSession(p.id)">
              <proto-icon name="plus" [size]="15" /> New Session
            </button>
            <button type="button" class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md border" [class.bg-sidebar-accent]="searching()" aria-label="Search this Project" title="Search this Project" (click)="toggleSearch()">
              <proto-icon name="search" [size]="15" />
            </button>
          </div>
          @if (searching()) {
            <input
              class="bg-background mt-2 h-8 rounded-md border px-2 outline-none"
              placeholder="Search {{ p.name }}"
              aria-label="Search this Project"
              [value]="proto.query()"
              (input)="proto.query.set($any($event.target).value)"
              (keydown.escape)="toggleSearch()"
            />
          }

          <div class="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto">
            @if (proto.draft()?.projectId === p.id) {
              <div class="text-muted-foreground flex h-12 items-center px-2 italic">New Session (draft, Tab only)</div>
            }
            @if (pinned().length > 0) {
              <div class="px-2 pt-1 pb-1 text-[11px] font-medium text-amber-700">Needs you</div>
              @for (x of pinned(); track x.id) {
                <ng-container *ngTemplateOutlet="row; context: { $implicit: x }" />
              }
            }
            @for (g of groups(); track g.label) {
              <div class="text-muted-foreground px-2 pt-3 pb-1 text-[11px] font-medium">{{ g.label }}</div>
              @for (x of g.items; track x.id) {
                <ng-container *ngTemplateOutlet="row; context: { $implicit: x }" />
              }
            }
            @if (list().length === 0 && proto.draft()?.projectId !== p.id) {
              <p class="text-muted-foreground m-0 px-2 py-6 text-center text-xs">
                {{ proto.query() ? 'No Sessions match.' : 'No Sessions in ' + p.name + ' yet.' }}
              </p>
            }
            @if (arch().length > 0) {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground mt-3 flex h-7 items-center gap-1.5 px-2 text-left text-xs"
                (click)="archOpen.set(!archOpen())"
                (contextmenu)="proto.openMenu($event, { kind: 'archived', id: p.id })"
              >
                <proto-icon name="chevron" [size]="12" class="transition-transform" [class.rotate-90]="archOpen()" />
                Archived ({{ arch().length }})
              </button>
              @if (archOpen()) {
                @for (x of arch(); track x.id) {
                  <ng-container *ngTemplateOutlet="row; context: { $implicit: x, archived: true }" />
                }
              }
            }
          </div>
        }

        <button type="button" class="hover:bg-sidebar-accent text-muted-foreground mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-left">
          <proto-icon name="sliders" /> Settings
        </button>
      </div>
    </hlm-sidebar>

    <ng-template #row let-x let-archived="archived">
      <button
        type="button"
        class="flex min-h-12 flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left"
        [class]="rowClass(x)"
        [class.opacity-70]="archived"
        [attr.aria-current]="proto.activeId() === x.id ? 'page' : null"
        (click)="proto.click($event, x.id, archived ? arch() : flat())"
        (contextmenu)="proto.openMenu($event, { kind: 'session', id: x.id })"
      >
        <span class="flex w-full items-center gap-2">
          @if (proto.renaming() === x.id) {
            <proto-rename [session]="x" />
          } @else {
            <span class="min-w-0 flex-1 truncate">{{ x.title }}</span>
          }
          <proto-marks [session]="x" />
        </span>
        <span class="text-muted-foreground text-[11px] font-normal">{{ meta(x) }}</span>
      </button>
    </ng-template>
  `,
})
export class VariantC {
  static readonly label = 'One Project at a time';
  protected readonly proto = inject(SidebarProto);
  protected readonly picker = signal(false);
  protected readonly searching = signal(false);
  protected readonly archOpen = signal(false);
  private readonly chosen = signal<string | null>(null);

  protected readonly current = computed(() => {
    const all = this.proto.orderedProjects();
    const activeProject = this.proto.draft()?.projectId ?? this.proto.active()?.projectId;
    return all.find((p) => p.id === this.chosen()) ?? all.find((p) => p.id === activeProject) ?? all[0] ?? null;
  });
  protected readonly list = computed(() => {
    const p = this.current();
    return p ? this.proto.listed(p.id) : [];
  });
  protected readonly pinned = computed(() => this.list().filter((x) => x.attention));
  protected readonly rest = computed(() => this.list().filter((x) => !x.attention));
  protected readonly flat = computed(() => [...this.pinned(), ...this.rest()]);
  protected readonly groups = computed(() => groupByDate(this.rest(), this.proto.sortKey()));
  protected readonly arch = computed(() => {
    const p = this.current();
    return p ? this.proto.archived(p.id) : [];
  });
  protected readonly othersAttention = computed(() => {
    const p = this.current();
    const others = this.proto.projects().filter((q) => q.id !== p?.id).map((q) => this.proto.projectAttention(q.id));
    return others.includes('error') ? 'error' : others.includes('answer') ? 'answer' : null;
  });

  protected rowClass = (x: Session) => rowClass(this.proto, x);

  protected meta(x: Session): string {
    const parts = [this.proto.order() === 'activity' ? `active ${relTime(x.lastActivityAt)}` : `started ${relTime(x.createdAt)}`];
    if (x.attention === 'answer') parts.push('waiting for your answer');
    if (x.attention === 'error') parts.push('last Turn failed');
    if (x.tabOpen) parts.push('open in a Tab');
    return parts.join(' · ');
  }
  protected pick(id: string): void {
    this.chosen.set(id);
    this.picker.set(false);
    this.proto.clearSelection();
  }
  protected toggleSearch(): void {
    this.searching.update((v) => !v);
    if (!this.searching()) this.proto.query.set('');
  }
}
