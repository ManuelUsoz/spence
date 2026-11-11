// PROTOTYPE (throwaway, branch prototype/project-sidebar): Variant B, "Recent, capped".
// No date labels: every Project shows its 5 most recent Sessions with a short age on the right
// ("3h", "2d"), then "Show N more". A filter field always sits at the top. Archived is one quiet row at the end.
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HlmSidebarImports } from '@ui/sidebar';
import { SidebarProto, relTime } from './proto-model';
import type { Session } from './proto-model';
import { ProtoIcon, ProtoMarks, ProtoRename, rowClass } from './proto-shared';
import { flip } from './variant-a-tree';

const CAP = 5;

@Component({
  selector: 'proto-variant-b',
  imports: [HlmSidebarImports, ProtoIcon, ProtoMarks, ProtoRename],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-sidebar collapsible="offcanvas">
      <div class="flex h-full flex-col px-2 py-3 text-sm">
        <div class="flex h-8 items-center px-2">
          <span class="flex-1 font-semibold">Spence</span>
        </div>
        <div class="relative mt-2">
          <proto-icon name="search" [size]="14" class="text-muted-foreground pointer-events-none absolute top-2 left-2.5" />
          <input
            class="bg-background h-8 w-full rounded-md border pr-2 pl-8 outline-none"
            placeholder="Filter Sessions and Projects"
            aria-label="Filter Sessions and Projects"
            [value]="proto.query()"
            (input)="proto.query.set($any($event.target).value)"
            (keydown.escape)="proto.query.set('')"
          />
        </div>

        <div class="mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
          @for (p of proto.orderedProjects(); track p.id) {
            @let list = proto.listed(p.id);
            @let arch = proto.archived(p.id);
            @if (proto.query() === '' || list.length + arch.length > 0) {
              <section class="flex flex-col gap-px">
                <div
                  class="flex h-7 items-center gap-1.5 pr-1 pl-2"
                  (contextmenu)="proto.openMenu($event, { kind: 'project', id: p.id })"
                >
                  <span class="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium tracking-wide uppercase">{{ p.name }}</span>
                  @if (p.folderMissing) {
                    <span class="text-destructive flex items-center gap-1 text-[11px]"><proto-icon name="folderX" [size]="13" /> missing</span>
                  }
                  <button type="button" class="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 items-center justify-center rounded" aria-label="New Session" title="New Session" (click)="proto.newSession(p.id)">
                    <proto-icon name="plus" [size]="14" />
                  </button>
                </div>

                @if (proto.draft()?.projectId === p.id) {
                  <div class="text-muted-foreground flex h-8 items-center px-2 italic">New Session (draft, Tab only)</div>
                }
                @if (list.length === 0 && proto.query() === '' && proto.draft()?.projectId !== p.id) {
                  <p class="text-muted-foreground m-0 px-2 py-1 text-xs">No Sessions yet.</p>
                }

                @for (x of visible(p.id, list); track x.id) {
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
                    @if (x.running || x.attention) {
                      <proto-marks [session]="x" />
                    } @else {
                      <span class="text-muted-foreground text-xs tabular-nums">{{ age(x) }}</span>
                    }
                  </button>
                }
                @if (list.length > cap && !expanded().has(p.id) && proto.query() === '') {
                  <button type="button" class="text-muted-foreground hover:text-foreground h-7 px-2 text-left text-xs" (click)="expand(p.id)">
                    Show {{ list.length - cap }} more
                  </button>
                }
                @if (expanded().has(p.id) && proto.query() === '') {
                  <button type="button" class="text-muted-foreground hover:text-foreground h-7 px-2 text-left text-xs" (click)="expand(p.id)">Show less</button>
                }

                @if (arch.length > 0) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground flex h-7 items-center gap-1.5 px-2 text-left text-xs"
                    [attr.aria-expanded]="archOpen().has(p.id)"
                    (click)="toggleArch(p.id)"
                    (contextmenu)="proto.openMenu($event, { kind: 'archived', id: p.id })"
                  >
                    <proto-icon name="archive" [size]="13" /> Archived ({{ arch.length }})
                    <proto-icon name="down" [size]="12" class="transition-transform" [class.rotate-180]="archOpen().has(p.id)" />
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
                        <span class="text-xs tabular-nums">{{ age(x) }}</span>
                      </button>
                    }
                  }
                }
              </section>
            }
          }
        </div>

        <div class="flex items-center gap-1">
          <button type="button" class="hover:bg-sidebar-accent text-muted-foreground flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-left">
            <proto-icon name="sliders" /> Settings
          </button>
          <button type="button" class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md" aria-label="Add Project" title="Add Project">
            <proto-icon name="folder" [size]="15" />
          </button>
        </div>
      </div>
    </hlm-sidebar>
  `,
})
export class VariantB {
  static readonly label = 'Recent, capped';
  protected readonly proto = inject(SidebarProto);
  protected readonly cap = CAP;
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly archOpen = signal<ReadonlySet<string>>(new Set());
  protected rowClass = (x: Session) => rowClass(this.proto, x);

  protected visible(projectId: string, list: Session[]): Session[] {
    if (this.proto.query() !== '' || this.expanded().has(projectId)) return list;
    // The open Session and anything calling for Attention always stay visible past the cap.
    const head = list.slice(0, CAP);
    const extra = list.slice(CAP).filter((x) => x.attention || x.id === this.proto.activeId());
    return [...head, ...extra];
  }
  protected age(x: Session): string {
    return relTime(this.proto.order() === 'activity' ? x.lastActivityAt : x.createdAt);
  }
  protected expand(id: string): void {
    this.expanded.update((s) => flip(s, id));
  }
  protected toggleArch(id: string): void {
    this.archOpen.update((s) => flip(s, id));
  }
}
