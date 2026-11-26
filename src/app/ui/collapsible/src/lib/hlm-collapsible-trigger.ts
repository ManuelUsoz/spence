import { Directive } from '@angular/core';
import { BrnCollapsibleTrigger } from '@spartan-ng/brain/collapsible';
import { classes } from '@ui/utils';

@Directive({
	selector: 'button[hlmCollapsibleTrigger]',
	exportAs: 'hlmCollapsibleTrigger',
	hostDirectives: [{ directive: BrnCollapsibleTrigger, inputs: ['type'] }],
	host: { 'data-slot': 'collapsible-trigger' },
})
export class HlmCollapsibleTrigger {
	constructor() {
		classes(() => 'cursor-pointer outline-none');
	}
}
