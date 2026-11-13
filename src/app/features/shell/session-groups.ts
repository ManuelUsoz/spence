import type { SessionSummary, SessionTitle } from '../../../shared/sessions/sessions.rpc';

/** A labelled run of Sessions in the sidebar list (Today, Yesterday, ...). */
export interface SessionGroup<T> {
  readonly label: string;
  readonly items: ReadonlyArray<T>;
}

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (time: number): number => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Whole calendar days between the two times, in local time. */
const daysBetween = (earlier: number, later: number): number =>
  Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);

const dayLabel = (time: number, now: number, locale: string): string => {
  const days = daysBetween(time, now);
  if (days <= 0) return $localize`Today`;
  if (days === 1) return $localize`Yesterday`;
  if (days <= 7) return $localize`Previous 7 days`;
  if (days <= 30) return $localize`Previous 30 days`;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(time);
};

/**
 * Groups items already sorted newest first into Today, Yesterday, Previous 7 days, Previous 30 days, then one group
 * per month and year.
 */
export const groupByDay = <T>(
  items: ReadonlyArray<T>,
  at: (item: T) => number,
  now: number,
  locale: string,
): ReadonlyArray<SessionGroup<T>> => {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = dayLabel(at(item), now, locale);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
};

/** How long ago, short: now, 5m, 2h, 3d, then the date. */
export const shortAge = (time: number, now: number, locale: string): string => {
  const elapsed = Math.max(0, now - time);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return $localize`:time since, under a minute:now`;
  if (minutes < 60) return $localize`:time since, in minutes:${minutes}:count:m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return $localize`:time since, in hours:${hours}:count:h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return $localize`:time since, in days:${days}:count:d`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(time);
};

/** What a Session is listed and tabbed by: the user's title, else the automatic one, else "New Session". */
export const sessionTitle = (title: SessionTitle): string =>
  title.user ?? title.auto ?? $localize`New Session`;

/** The Sessions a Project lists (archived ones are not), newest activity first. */
export const listed = (sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<SessionSummary> =>
  sessions
    .filter((session) => session.archivedAt === undefined)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

/** Maximum non-archived Sessions shown per Project in All Projects layout before expanding. */
export const ALL_PROJECTS_CAP = 5;

/** How many archived Sessions a Project has (hook for the Archived fold). */
export const archivedCount = (sessions: ReadonlyArray<SessionSummary>): number =>
  sessions.filter((session) => session.archivedAt !== undefined).length;

export interface CapResult<T> {
  readonly visible: ReadonlyArray<T>;
  readonly hiddenCount: number;
}

/** Caps a Project's Sessions at `cap` while keeping pinned items visible past the cap. */
export const capSessions = <T>(
  items: ReadonlyArray<T>,
  options: {
    readonly cap: number;
    readonly expanded: boolean;
    readonly isPinned: (item: T) => boolean;
  },
): CapResult<T> => {
  const hiddenCount = items.filter(
    (item, index) => index >= options.cap && !options.isPinned(item),
  ).length;
  const visible = options.expanded
    ? items
    : items.filter((item, index) => index < options.cap || options.isPinned(item));
  return { visible, hiddenCount };
};
