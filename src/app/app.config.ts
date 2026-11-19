import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { AGENT_INSTALL_OFFER } from './core/agent-install-offer';
import { BROWSER_PANE_VIEW } from './core/browser-pane';
import { AgentInstallOffer } from './features/agent-install/agent-install';
import { BrowserPane } from './features/browser/browser-pane';
import { CHANGES_VIEW } from './core/changes-view';
import { SESSION_VIEW } from './core/session-view';
import { ChangesPage } from './features/changes/changes-page';
import { SessionTab } from './features/session/session-tab';

// Hash routing: the packaged app loads from file://, where path URLs do not resolve.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation()),
    { provide: AGENT_INSTALL_OFFER, useValue: AgentInstallOffer },
    // The shell shows the active Tab's Session with the Session feature's view.
    { provide: SESSION_VIEW, useValue: SessionTab },
    // ...and its Changes with the Changes feature's view.
    { provide: CHANGES_VIEW, useValue: ChangesPage },
    // ...and its embedded Browser pane with the Browser feature's view.
    { provide: BROWSER_PANE_VIEW, useValue: BrowserPane },
  ],
};
