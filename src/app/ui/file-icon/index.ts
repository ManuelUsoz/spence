import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Original, bundled vector artwork; decorative alongside the visible file name. */
@Component({
  selector: 'ui-file-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex size-4 shrink-0', 'aria-hidden': 'true', '[attr.data-file-icon]': 'icon()' },
  template: `
    <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      @if (icon() === 'folder' || icon() === 'folder-open') {
        @if (icon() === 'folder') {
          <path d="M3 6h7l2 2h9v11H3z" />
        } @else {
          <path d="M3 18V6h7l2 2h9v3M3 18l2-7h17l-2 7z" />
        }
      } @else {
        <path d="M5 3h9l5 5v13H5z M14 3v5h5" />
        @switch (icon()) {
          @case ('package') { <path d="M8 13l4-2 4 2-4 2z M8 13v3l4 2 4-2v-3 M12 15v3" /> }
          @case ('lock') { <rect x="9" y="14" width="6" height="5" rx="1" /><path d="M10 14v-1a2 2 0 014 0v1" /> }
          @case ('docker') { <path d="M8 15h9l-1 3H9z M9 12h2v2H9z M12 12h2v2h-2z" /> }
          @case ('git') { <circle cx="9" cy="12" r="1" /><circle cx="15" cy="17" r="1" /><path d="M9 13v2c0 2 2 2 5 2" /> }
          @case ('env') { <path d="M9 12h6 M9 15h4 M9 18h6" /> }
          @case ('readme') { <path d="M8 12h8 M8 15h8 M8 18h5" /> }
          @case ('markdown') { <path d="M8 17v-5l2 3 2-3v5 M15 12v5m-2-2 2 2 2-2" /> }
          @case ('image') { <circle cx="10" cy="12" r="1" /><path d="M8 18l3-3 2 2 2-3 2 4z" /> }
          @default { <text x="12" y="17" text-anchor="middle" stroke="none" fill="currentColor" font-size="6">{{ mark() }}</text> }
        }
      }
    </svg>
  `,
})
export class FileIcon {
  readonly icon = input.required<string>();
  protected mark(): string {
    const marks: Readonly<Record<string, string>> = {
      typescript: 'TS', javascript: 'JS', json: '{}', html: '<>', css: '#',
      config: '?', python: 'Py', rust: 'Rs', go: 'Go', terminal: '>_',
    };
    return marks[this.icon()] ?? '';
  }
}
