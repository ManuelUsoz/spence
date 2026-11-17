import type { SessionSummary, SessionTitle } from '../../../shared/sessions/sessions.rpc';
import { titleOf } from '../../core/tabs';

/** A labelled run of Sessions in the sidebar list (Needs you, Today, Earlier). */
export interface SessionGroup<T> {
  readonly label: string;
  readonly items: ReadonlyArray<T>;
}

const startOfDay = (time: number): number => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Splits items already sorted newest first into Today and Earlier (local calendar days); empty groups are left out. */
export const groupTodayEarlier = <T>(
  items: ReadonlyArray<T>,
  at: (item: T) => number,
  now: number,
): ReadonlyArray<SessionGroup<T>> => {
  const today = startOfDay(now);
  const recent = items.filter((item) => at(item) >= today);
  const earlier = items.filter((item) => at(item) < today);
  return [
    ...(recent.length > 0 ? [{ label: $localize`Today`, items: recent }] : []),
    ...(earlier.length > 0 ? [{ label: $localize`Earlier`, items: earlier }] : []),
  ];
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
  titleOf(title) ?? $localize`New Session`;

/** The Sessions a Project lists (archived ones are not), newest activity first. */
export const listed = (sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<SessionSummary> =>
  sessions
    .filter((session) => session.archivedAt === undefined)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

/** Sessions listed before "Show more"; the open and running ones stay visible past it. */
export const SESSION_CAP = 12;

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

/** The Project's archived Sessions, newest activity first. */
export const archived = (sessions: ReadonlyArray<SessionSummary>): ReadonlyArray<SessionSummary> =>
  sessions
    .filter((session) => session.archivedAt !== undefined)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
