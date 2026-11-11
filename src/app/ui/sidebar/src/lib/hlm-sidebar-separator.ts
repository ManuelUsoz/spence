import { Directive } from '@angular/core';
import { HlmSeparator } from '@ui/separator';
import { classes } from '@ui/utils';

@Directive({
	selector: '[hlmSidebarSeparator],hlm-sidebar-separator',
	exportAs: 'hlmSidebarSeparator',
	hostDirectives: [HlmSeparator],
	host: {
		'data-slot': 'sidebar-separator',
		'data-sidebar': 'separator',
	},
})
export class HlmSidebarSeparator {
	constructor() {
		classes(() => 'bg-sidebar-border mx-2 w-auto');
	}
}
