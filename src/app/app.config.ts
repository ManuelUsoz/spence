import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { AGENT_INSTALL_OFFER } from './core/agent-install-offer';
import { AgentInstallOffer } from './features/agent-install/agent-install';

// Hash routing: the packaged app loads from file://, where path URLs do not resolve.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation()),
    { provide: AGENT_INSTALL_OFFER, useValue: AgentInstallOffer },
  ],
};
