import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { SESSION_VIEW } from './core/session-view';
import { SessionTab } from './features/session/session-tab';

// Hash routing: the packaged app loads from file://, where path URLs do not resolve.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation()),
    // The shell shows the active Tab's Session with the Session feature's view.
    { provide: SESSION_VIEW, useValue: SessionTab },
  ],
};
