import { Directive } from '@angular/core';
import { classes } from '@ui/utils';

@Directive({
	selector: '[hlmCodeBlockTitle],hlm-code-block-title',
	exportAs: 'hlmCodeBlockTitle',
	host: { 'data-slot': 'code-block-title' },
})
export class HlmCodeBlockTitle {
	constructor() {
		classes(
			() =>
				"text-foreground group-data-[variant=destructive]/code-block:text-destructive font-sans text-xs font-medium [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(3.5)] *:[ng-icon]:me-1.5 min-w-0 truncate [&_ng-icon]:pointer-events-none [&_ng-icon]:inline-block [&_ng-icon]:align-middle",
		);
	}
}
