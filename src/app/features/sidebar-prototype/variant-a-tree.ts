// PROTOTYPE (throwaway, branch prototype/project-sidebar): Variant A, "Tree by day".
// Every Project is a collapsible folder; its Sessions are split under small date labels
// (Today, Yesterday, Previous 7 days, ...). Search is an icon that opens a field filtering every Project in place.
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HlmSidebarImports } from '@ui/sidebar';
import { SidebarProto, groupByDate } from './proto-model';
import { ProtoIcon, ProtoMarks, ProtoRename, rowClass } from './proto-shared';

@Component({
  selector: 'proto-variant-a',
  imports: [HlmSidebarImports, ProtoIcon, ProtoMarks, ProtoRename],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-sidebar collapsible="offcanvas">
      <div class="flex h-full flex-col px-2 py-3 text-sm">
        <div class="flex h-8 items-center gap-1 pr-1 pl-2">
          <span class="flex-1 font-semibold">Spence</span>
          <button type="button" class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md" aria-label="Search Sessions" title="Search Sessions" (click)="toggleSearch()">
            <proto-icon name="search" />
          </button>
          <button type="button" class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md" aria-label="Add Project" title="Add Project">
            <proto-icon name="plus" />
          </button>
        </div>
        @if (searching()) {
          <input
            class="bg-background mt-2 h-8 rounded-md border px-2 outline-none"
            placeholder="Search Sessions"
            aria-label="Search Sessions"
            [value]="proto.query()"
            (input)="proto.query.set($any($event.target).value)"
            (keydown.escape)="toggleSearch()"
            autofocus
          />
        }

        <div class="mt-3 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          @for (p of proto.orderedProjects(); track p.id) {
            @let list = proto.listed(p.id);
            @let arch = proto.archived(p.id);
            @let open = !collapsed().has(p.id) || proto.query() !== '';
            @if (proto.query() === '' || list.length + arch.length > 0) {
              <div>
                <div
                  class="group hover:bg-sidebar-accent flex h-8 items-center gap-1.5 rounded-md pr-1 pl-1.5"
                  (contextmenu)="proto.openMenu($event, { kind: 'project', id: p.id })"
                >
                  <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 text-left" [attr.aria-expanded]="open" (click)="toggle(p.id)">
                    <proto-icon name="chevron" [size]="14" class="text-muted-foreground transition-transform" [class.rotate-90]="open" />
                    <proto-icon [name]="p.folderMissing ? 'folderX' : 'folder'" [size]="15" [class]="p.folderMissing ? 'text-destructive' : 'text-muted-foreground'" [attr.title]="p.folderMissing ? 'Folder missing' : null" />
                    <span class="truncate font-medium">{{ p.name }}</span>
                  </button>
                  @if (!open) {
                    @switch (proto.projectAttention(p.id)) {
                      @case ('answer') { <span class="size-2 rounded-full bg-amber-500" aria-label="Needs an answer"></span> }
                      @case ('error') { <span class="bg-destructive size-2 rounded-full" aria-label="Error"></span> }
                    }
                  }
                  <button type="button" class="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="New Session" title="New Session" (click)="proto.newSession(p.id)">
                    <proto-icon name="plus" [size]="14" />
                  </button>
                </div>

                @if (open) {
                  <div class="ml-[13px] flex flex-col border-l pl-2">
                    @if (proto.draft()?.projectId === p.id) {
                      <div class="text-muted-foreground flex h-8 items-center px-2 italic">New Session (draft, Tab only)</div>
                    }
                    @if (list.length === 0 && arch.length === 0 && proto.draft()?.projectId !== p.id) {
                      <button type="button" class="text-muted-foreground hover:text-foreground flex h-8 items-center gap-2 px-2 text-left" (click)="proto.newSession(p.id)">
                        <proto-icon name="plus" [size]="14" /> New Session
                      </button>
                    }
                    @for (g of groups(list); track g.label) {
                      <div class="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-medium">{{ g.label }}</div>
                      @for (x of g.items; track x.id) {
                        <button
                          type="button"
                          class="flex h-8 items-center gap-2 rounded-md px-2 text-left"
                          [class]="rowClass(x)"
                          [attr.aria-current]="proto.activeId() === x.id ? 'page' : null"
                          (click)="proto.click($event, x.id, list)"
                          (contextmenu)="proto.openMenu($event, { kind: 'session', id: x.id })"
                        >
                          @if (proto.renaming() === x.id) {
                            <proto-rename [session]="x" />
                          } @else {
                            <span class="min-w-0 flex-1 truncate">{{ x.title }}</span>
                          }
                          <proto-marks [session]="x" />
                        </button>
                      }
                    }
                    @if (arch.length > 0) {
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground mt-1 flex h-7 items-center gap-1.5 px-2 text-left text-xs"
                        [attr.aria-expanded]="archOpen().has(p.id)"
                        (click)="toggleArch(p.id)"
                        (contextmenu)="proto.openMenu($event, { kind: 'archived', id: p.id })"
                      >
                        <proto-icon name="chevron" [size]="12" class="transition-transform" [class.rotate-90]="archOpen().has(p.id)" />
                        Archived ({{ arch.length }})
                      </button>
                      @if (archOpen().has(p.id)) {
                        @for (x of arch; track x.id) {
                          <button
                            type="button"
                            class="text-muted-foreground flex h-8 items-center gap-2 rounded-md px-2 text-left"
                            [class]="rowClass(x)"
                            (click)="proto.click($event, x.id, arch)"
                            (contextmenu)="proto.openMenu($event, { kind: 'session', id: x.id })"
                          >
                            <span class="min-w-0 flex-1 truncate">{{ x.title }}</span>
                          </button>
                        }
                      }
                    }
                  </div>
                }
              </div>
            }
          }
        </div>

        <button type="button" class="hover:bg-sidebar-accent text-muted-foreground flex h-8 items-center gap-2 rounded-md px-2 text-left">
          <proto-icon name="sliders" /> Settings
        </button>
      </div>
    </hlm-sidebar>
  `,
})
export class VariantA {
  static readonly label = 'Tree by day';
  protected readonly proto = inject(SidebarProto);
  protected readonly searching = signal(false);
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly archOpen = signal<ReadonlySet<string>>(new Set());

  protected groups = (list: Parameters<typeof groupByDate>[0]) => groupByDate(list, this.proto.sortKey());
  protected rowClass = (x: Parameters<typeof rowClass>[1]) => rowClass(this.proto, x);

  protected toggleSearch(): void {
    this.searching.update((v) => !v);
    if (!this.searching()) this.proto.query.set('');
  }
  protected toggle(id: string): void {
    this.collapsed.update((s) => flip(s, id));
  }
  protected toggleArch(id: string): void {
    this.archOpen.update((s) => flip(s, id));
  }
}

export function flip(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
