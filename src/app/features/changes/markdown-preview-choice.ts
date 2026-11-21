import { Injectable, signal } from '@angular/core';

/** The preview choice lasts for the lifetime of the renderer. */
@Injectable({ providedIn: 'root' })
export class MarkdownPreviewChoice {
  readonly source = signal(false);
}
