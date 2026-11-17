import { Directive } from '@angular/core';
import { classes } from '@ui/utils';

@Directive({
	selector: '[hlmCodeBlockFooter],hlm-code-block-footer',
	exportAs: 'hlmCodeBlockFooter',
	host: { 'data-slot': 'code-block-footer' },
})
export class HlmCodeBlockFooter {
	constructor() {
		classes(() => 'text-muted-foreground gap-2 px-3 pb-3 group-data-[size=sm]/code-block:px-2 group-data-[size=sm]/code-block:pb-2 flex min-w-0 shrink-0 items-center');
	}
}
