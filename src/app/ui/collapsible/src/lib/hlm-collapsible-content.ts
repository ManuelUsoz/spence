import { Directive } from '@angular/core';
import { BrnCollapsibleContent } from '@spartan-ng/brain/collapsible';
import { classes } from '@ui/utils';

@Directive({
	selector: '[hlmCollapsibleContent],hlm-collapsible-content',
	exportAs: 'hlmCollapsibleContent',
	hostDirectives: [{ directive: BrnCollapsibleContent, inputs: ['id'] }],
	host: { 'data-slot': 'collapsible-content' },
})
export class HlmCollapsibleContent {
	constructor() {
		classes(
			() =>
				'block min-w-0 overflow-hidden transition-[height] duration-200 data-[state=closed]:h-0 data-[state=open]:h-(--brn-collapsible-content-height) motion-reduce:transition-none',
		);
	}
}
