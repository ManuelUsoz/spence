import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { toast } from '@ui/toast';

@Injectable()
export class ChangesErrors {
  readonly details = signal<{ readonly text: string; readonly output: string } | null>(null);

  report(
    text: string,
    output?: string,
    action?: { readonly label: string; readonly run: () => void },
  ): void {
    const view = output
      ? { label: $localize`View details`, onClick: () => this.details.set({ text, output }) }
      : undefined;
    toast.error(text, {
      duration: action || view ? 15000 : 4000,
      ...(action
        ? {
            action: { label: action.label, onClick: action.run },
            ...(view ? { cancel: view } : {}),
          }
        : view
          ? { action: view }
          : {}),
    });
  }
}

@Component({
  selector: 'app-changes-error-details',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (errors.details(); as details) {
      <section
        class="border-border/60 flex shrink-0 flex-col gap-2 border-b p-4"
        data-testid="changes-error-details"
        aria-label="Error details"
        i18n-aria-label
      >
        <div class="flex items-center gap-2">
          <p class="min-w-0 flex-1 text-sm">{{ details.text }}</p>
          <button hlmBtn variant="outline" size="sm" (click)="close()" i18n>Close</button>
        </div>
        <pre
          class="border-border/60 max-h-64 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
          >{{ details.output }}</pre>
      </section>
    }
  `,
})
export class ChangesErrorDetails {
  protected readonly errors = inject(ChangesErrors);
  protected close(): void {
    this.errors.details.set(null);
  }
}
