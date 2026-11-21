import { inject, Injector, type ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { AGENT_INSTALL_OFFER } from './core/agent-install-offer';
import { PANEL_DEFINITION, type PanelDefinition } from './core/panel-registry';
import { Tabs } from './core/tabs';
import { AgentInstallOffer } from './features/agent-install/agent-install';
import { ChangesPage } from './features/changes/changes-page';
import { SessionTab } from './features/session/session-tab';
import { WorkersPanelHost } from './features/session/workers-panel';

const createSessionPanelDefinition = (): PanelDefinition => {
  const injector = inject(Injector);
  return {
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
    inputs: (context) => {
      const device = injector.get(Tabs).projectDevice(context.projectId);
      return {
        panel: context.panel,
        paneId: context.paneId ?? null,
        projectId: context.projectId,
        projectName: context.projectName,
        focused: context.focused,
        ...(device === undefined ? {} : { device }),
      };
    },
  };
};

const createChangesPanelDefinition = (): PanelDefinition => {
  const injector = inject(Injector);
  return {
    kind: 'Changes',
    component: ChangesPage,
    defaultTitle: $localize`Changes`,
    headerMeta: () => ({ title: $localize`Changes`, untitled: false }),
    inputs: (context) => {
      const sessionId =
        context.panel.spec._tag === 'Changes' ? context.panel.spec.sessionId : undefined;
      const tabs = injector.get(Tabs);
      return {
        sessionId,
        running: sessionId !== undefined && (tabs.sessionStatus(sessionId)?.running ?? false),
      };
    },
  };
};

const workersPanelDefinition: PanelDefinition = {
  kind: 'Workers',
  component: WorkersPanelHost,
  defaultTitle: $localize`Workers`,
  headerMeta: () => ({ title: $localize`Workers`, untitled: false }),
  inputs: (context) => ({
    panel: context.panel,
    paneId: context.paneId ?? null,
    projectId: context.projectId,
  }),
};

// Hash routing: the packaged app loads from file://, where path URLs do not resolve.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withHashLocation()),
    { provide: AGENT_INSTALL_OFFER, useValue: AgentInstallOffer },
    // Register Panel types with the extensible Panel registry (Session covers local, Worker, and Remote Sessions).
    { provide: PANEL_DEFINITION, multi: true, useFactory: createSessionPanelDefinition },
    { provide: PANEL_DEFINITION, multi: true, useFactory: createChangesPanelDefinition },
    { provide: PANEL_DEFINITION, multi: true, useValue: workersPanelDefinition },
  ],
};
