import { Directive } from '@angular/core';
import { BrnAutocompleteSeparator } from '@spartan-ng/brain/autocomplete';
import { classes } from '@ui/utils';

@Directive({
	selector: '[hlmAutocompleteSeparator]',
	exportAs: 'hlmAutocompleteSeparator',
	hostDirectives: [{ directive: BrnAutocompleteSeparator, inputs: ['orientation'] }],
	host: { 'data-slot': 'autocomplete-separator' },
})
export class HlmAutocompleteSeparator {
	constructor() {
		classes(() => 'bg-border/50 -mx-1 my-1 h-px');
	}
}
