/** The look of one button of a segmented switch (tabs, Unified / Split, Rendered / Source). */
export const segmentClass = (active: boolean): string =>
  active ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground';
