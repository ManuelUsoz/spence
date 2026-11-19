import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { AGENT_INSTALL_OFFER } from './core/agent-install-offer';
import { CHANGES_VIEW } from './core/changes-view';
import { PANEL_DEFINITION, type PanelDefinition } from './core/panel-registry';
import { AgentInstallOffer } from './features/agent-install/agent-install';
import { ChangesPage } from './features/changes/changes-page';
import { SessionTab } from './features/session/session-tab';

const sessionPanelDefinition: PanelDefinition = {
  kind: 'Session',
  component: SessionTab,
  headerMeta: (context, resolveSessionTitle) => {
    const spec = context.panel.spec;
    if (spec._tag !== 'Session' || spec.draft === true || spec.sessionId === undefined) {
      return { title: $localize`New Session`, untitled: true };
    }
    const title = resolveSessionTitle(spec.sessionId);
    return title === null
      ? { title: $localize`New Session`, untitled: true }
      : { title, untitled: false };
  },
};

// Hash routing: the packaged app loads from file://, where path URLs do not resolve.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation()),
    { provide: AGENT_INSTALL_OFFER, useValue: AgentInstallOffer },
    // Register Panel types with the extensible Panel registry (Session covers local, Worker, and Remote Sessions).
    { provide: PANEL_DEFINITION, multi: true, useValue: sessionPanelDefinition },
    // Temporary full-view Changes slot until #206 registers Changes as a Panel type.
    { provide: CHANGES_VIEW, useValue: ChangesPage },
  ],
};
