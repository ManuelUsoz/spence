// PROTOTYPE (throwaway, branch prototype/calm-thread): small pieces every variant may reuse.
// Only vocabulary lives here (icons, Message parts, outcome lines); layout belongs to each variant.
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type { OnDestroy } from '@angular/core';

/** Keeps a scroll container pinned to the bottom while content streams, unless the user scrolled up. */
@Directive({ selector: '[protoStickToBottom]' })
export class ProtoStickToBottom implements OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private pinned = true;
  private readonly observer = new MutationObserver(() => {
    if (this.pinned) this.el.scrollTop = this.el.scrollHeight;
  });
  constructor() {
    this.observer.observe(this.el, { childList: true, subtree: true, characterData: true });
    this.el.addEventListener('scroll', () => {
      this.pinned = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    });
    queueMicrotask(() => (this.el.scrollTop = this.el.scrollHeight));
  }
  ngOnDestroy(): void {
    this.observer.disconnect();
  }
}
import type { Diff, MessageEntry, Part, StepKind } from './prototype-model';

const PATHS: Record<string, string> = {
  check: 'M20 6 9 17l-5-5',
  chevron: 'm9 18 6-6-6-6',
  down: 'm6 9 6 6 6-6',
  x: 'M18 6 6 18M6 6l12 12',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  play: 'm6 3 14 9-14 9z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  thought: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18zM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  terminal: 'm4 17 6-6-6-6M12 19h8',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  move: 'M5 12h14M13 6l6 6-6 6',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  dot: 'M12 12h.01',
  compress: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  eraser: 'M7 21h10M5 14l7-7 6 6-7 7H8z',
  square: 'M5 5h14v14H5z',
  text: 'M4 6h16M4 12h16M4 18h10',
};

export function kindIcon(kind: StepKind): string {
  switch (kind) {
    case 'read':
      return 'eye';
    case 'edit':
      return 'pencil';
    case 'delete':
      return 'trash';
    case 'move':
      return 'move';
    case 'search':
      return 'search';
    case 'execute':
      return 'terminal';
    case 'fetch':
      return 'globe';
    case 'other':
      return 'dot';
  }
}

@Component({
  selector: 'proto-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="stroke()"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path [attr.d]="d()" />
    </svg>
  `,
})
export class ProtoIcon {
  readonly name = input.required<string>();
  readonly size = input(14);
  readonly stroke = input(2);
  protected readonly d = computed(() => PATHS[this.name()] ?? '');
}

@Component({
  selector: 'proto-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <svg
      class="animate-spin motion-reduce:animate-none"
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      role="img"
      aria-label="Working"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  `,
})
export class ProtoSpinner {
  readonly size = input(14);
}

/** Splits `code` spans out of agent text. Real markdown rendering is out of this prototype's scope. */
@Component({
  selector: 'proto-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (seg of segs(); track $index) {@if (seg.code) {<code class="bg-muted rounded px-1 py-px font-mono text-[13px]">{{ seg.text }}</code>} @else {{{ seg.text }}}}`,
})
export class ProtoText {
  readonly text = input.required<string>();
  protected readonly segs = computed(() =>
    this.text()
      .split('`')
      .map((text, i) => ({ text, code: i % 2 === 1 })),
  );
}

@Component({
  selector: 'proto-parts',
  imports: [ProtoIcon, ProtoText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3">
      @for (part of parts(); track $index) {
        @switch (part.kind) {
          @case ('text') {
            <p class="m-0 leading-6 whitespace-pre-wrap"><proto-text [text]="part.text" />@if (streaming() && $last) {<span class="bg-foreground/60 ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse"></span>}</p>
          }
          @case ('link') {
            <a
              href="#"
              (click)="$event.preventDefault()"
              class="hover:bg-muted inline-flex max-w-full items-center gap-2 self-start rounded-lg border px-2.5 py-1.5 text-sm no-underline"
              [title]="part.uri"
            >
              <proto-icon [name]="part.uri.startsWith('http') ? 'globe' : 'file'" class="text-muted-foreground" />
              <span class="truncate font-medium">{{ part.name }}</span>
              @if (part.title) {
                <span class="text-muted-foreground truncate">{{ part.title }}</span>
              }
            </a>
          }
          @case ('image') {
            <div
              role="img"
              [attr.aria-label]="'Image: ' + part.name"
              class="bg-muted/60 flex h-28 w-44 items-end overflow-hidden rounded-xl border p-2"
            >
              <span class="bg-background/90 text-muted-foreground rounded px-1.5 text-xs">{{ part.name }}</span>
            </div>
          }
          @case ('audio') {
            <div class="flex w-60 items-center gap-3 self-start rounded-full border py-1.5 pr-4 pl-1.5">
              <span class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-full">
                <proto-icon name="play" [size]="12" />
              </span>
              <span class="bg-border h-1 flex-1 rounded-full"></span>
              <span class="text-muted-foreground text-xs tabular-nums">0:{{ part.seconds }}</span>
            </div>
          }
          @case ('resource') {
            <details class="self-stretch rounded-lg border text-sm">
              <summary class="text-muted-foreground flex cursor-pointer items-center gap-2 px-3 py-2">
                <proto-icon name="file" />
                <span class="text-foreground truncate font-mono text-xs">{{ part.uri.replace('file:///', '') }}</span>
                <span class="ml-auto text-xs">attached</span>
              </summary>
              <pre class="bg-muted/50 m-0 overflow-x-auto border-t p-3 font-mono text-xs">{{ part.text }}</pre>
            </details>
          }
        }
      }
    </div>
  `,
})
export class ProtoParts {
  readonly parts = input.required<readonly Part[]>();
  readonly streaming = input(false);
}

@Component({
  selector: 'proto-user-message',
  imports: [ProtoParts],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col items-end self-end max-w-[80%]' },
  template: `
    @let ps = msg().parts;
    <div class="flex flex-col items-end gap-1.5">
      @for (part of ps; track $index) {
        @if (part.kind === 'text') {
          <div class="bg-muted rounded-[18px] px-4 py-2.5 leading-[22px] whitespace-pre-wrap">{{ part.text }}</div>
        } @else {
          <proto-parts [parts]="[part]" />
        }
      }
    </div>
  `,
})
export class ProtoUserMessage {
  readonly msg = input.required<MessageEntry>();
}

@Component({
  selector: 'proto-diff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overflow-hidden rounded-lg border text-xs">
      <div class="bg-muted/50 text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 font-mono">
        <span class="text-foreground truncate">{{ diff().path }}</span>
        @if (diff().isNew) {
          <span class="ml-auto">new file</span>
        }
      </div>
      <pre class="m-0 overflow-x-auto py-1 font-mono leading-5">@for (l of diff().lines; track $index) {<div [class]="l.op === '+' ? 'bg-emerald-500/10 px-3' : l.op === '-' ? 'bg-red-500/10 px-3' : 'px-3'"><span class="text-muted-foreground mr-2 select-none">{{ l.op }}</span>{{ l.text }}</div>}</pre>
    </div>
  `,
})
export class ProtoDiff {
  readonly diff = input.required<Diff>();
}

/** A folded block of text (stderr tail, step output). */
@Component({
  selector: 'proto-fold',
  imports: [ProtoIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
      [attr.aria-expanded]="open()"
      (click)="open.set(!open())"
    >
      <proto-icon name="chevron" [size]="12" [class]="open() ? 'rotate-90 transition-transform' : 'transition-transform'" />
      {{ label() }}
    </button>
    @if (open()) {
      <pre class="bg-muted/50 mt-1.5 mb-0 max-h-48 overflow-auto rounded-md p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap">{{ text() }}</pre>
    }
  `,
})
export class ProtoFold {
  readonly label = input.required<string>();
  readonly text = input.required<string>();
  protected readonly open = signal(false);
}
