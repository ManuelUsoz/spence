import { Directive } from '@angular/core';
import { BrnCollapsible } from '@spartan-ng/brain/collapsible';
import { classes } from '@ui/utils';

@Directive({
	selector: '[hlmCollapsible],hlm-collapsible',
	exportAs: 'hlmCollapsible',
	hostDirectives: [
		{
			directive: BrnCollapsible,
			inputs: ['expanded', 'disabled'],
			outputs: ['expandedChange'],
		},
	],
	host: { 'data-slot': 'collapsible' },
})
export class HlmCollapsible {
	constructor() {
		classes(() => 'block min-w-0');
	}
}
