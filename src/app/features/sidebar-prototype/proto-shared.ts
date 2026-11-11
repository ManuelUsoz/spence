// PROTOTYPE (throwaway, branch prototype/project-sidebar): vocabulary every variant may reuse:
// icons, the running / Attention marks, the rename input, and the overlays (context menu, toast, confirm).
// Layout belongs to each variant.
import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, inject, input } from '@angular/core';
import { SidebarProto } from './proto-model';
import type { Session } from './proto-model';

const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  chevron: 'm9 18 6-6-6-6',
  down: 'm6 9 6 6 6-6',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
  folderX: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2zM9.5 10.5l5 5M14.5 10.5l-5 5',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  settings: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
};

@Component({
  selector: 'proto-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path [attr.d]="d()" />
    </svg>
  `,
})
export class ProtoIcon {
  readonly name = input.required<string>();
  readonly size = input(16);
  protected d(): string {
    return PATHS[this.name()] ?? '';
  }
}

/** Running is a static mark (#11); Attention is an amber (needs answer) or red (error) dot. */
@Component({
  selector: 'proto-marks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center gap-1.5 shrink-0' },
  template: `
    @let x = session();
    @if (x.attention === 'answer') {
      <span class="size-2 rounded-full bg-amber-500" role="img" aria-label="Needs an answer" title="Needs an answer"></span>
    } @else if (x.attention === 'error') {
      <span class="bg-destructive size-2 rounded-full" role="img" aria-label="Error" title="Error"></span>
    }
    @if (x.running) {
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="text-muted-foreground" role="img" aria-label="Running">
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
    }
  `,
})
export class ProtoMarks {
  readonly session = input.required<Session>();
}

@Component({
  selector: 'proto-rename',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex-1 min-w-0' },
  template: `
    <input
      class="bg-background w-full rounded-md border px-1.5 py-0.5 text-sm outline-none"
      aria-label="Session name"
      [value]="session().title"
      (keydown.enter)="proto.rename(session().id, $any($event.target).value)"
      (keydown.escape)="proto.renaming.set(null)"
      (blur)="proto.rename(session().id, $any($event.target).value)"
      (click)="$event.stopPropagation()"
    />
  `,
})
export class ProtoRename {
  readonly session = input.required<Session>();
  protected readonly proto = inject(SidebarProto);
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => el.querySelector('input')?.select());
  }
}

/** Context menu, Undo toast and delete confirm: one look for every variant (stand-ins for Spartan's). */
@Component({
  selector: 'proto-overlays',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'escape()' },
  template: `
    @if (proto.menu(); as m) {
      <div class="fixed inset-0 z-40" (click)="proto.menu.set(null)" (contextmenu)="$event.preventDefault(); proto.menu.set(null)"></div>
      <div
        role="menu"
        class="bg-popover text-popover-foreground fixed z-50 min-w-[200px] rounded-lg border p-1 text-sm shadow-lg"
        [style.left.px]="m.x"
        [style.top.px]="m.y"
      >
        @for (item of proto.menuItems(); track item.label) {
          @if (item.separator) {
            <div class="bg-border -mx-1 my-1 h-px"></div>
          }
          <button
            type="button"
            role="menuitem"
            class="hover:bg-accent flex h-8 w-full items-center rounded-md px-2 text-left"
            [class.text-destructive]="item.danger"
            (click)="item.run(); proto.menu.set(null)"
          >
            {{ item.label }}
          </button>
        }
      </div>
    }

    @if (proto.toast(); as t) {
      <div class="bg-popover fixed right-4 bottom-20 z-50 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg" role="status">
        <span>{{ t.text }}</span>
        @if (t.undo) {
          <button type="button" class="bg-primary text-primary-foreground h-7 rounded-md px-2.5 text-xs font-medium" (click)="t.undo(); proto.toast.set(null)">Undo</button>
        }
      </div>
    }

    @if (proto.confirm(); as c) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div role="alertdialog" class="bg-background w-[380px] rounded-xl border p-5 shadow-xl">
          <p class="m-0 text-sm">{{ c.text }}</p>
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="hover:bg-accent h-8 rounded-md border px-3 text-sm" (click)="proto.confirm.set(null)">Cancel</button>
            <button type="button" class="bg-destructive h-8 rounded-md px-3 text-sm text-white" (click)="c.ok(); proto.confirm.set(null)">Delete</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ProtoOverlays {
  protected readonly proto = inject(SidebarProto);
  protected escape(): void {
    if (this.proto.menu()) this.proto.menu.set(null);
    else if (this.proto.confirm()) this.proto.confirm.set(null);
    else this.proto.clearSelection();
  }
}

/** The shared row look for "selected" in multi-select. */
export function rowClass(proto: SidebarProto, x: Session): string {
  if (proto.selection().has(x.id)) return 'bg-sidebar-primary/10 ring-1 ring-inset ring-sidebar-primary/30';
  if (proto.activeId() === x.id) return 'bg-sidebar-accent font-medium';
  return 'hover:bg-sidebar-accent';
}
