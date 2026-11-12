import { InjectionToken, type Type } from '@angular/core';

/**
 * The component that shows the active Tab's Session, taking the Tab as its `tab` input. Features never import each
 * other, so the shell renders whatever `app.config.ts` provides here; none leaves the shell's placeholder alone.
 */
export const SESSION_VIEW = new InjectionToken<Type<unknown> | null>('SESSION_VIEW', {
  providedIn: 'root',
  factory: () => null,
});
