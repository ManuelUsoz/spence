import { InjectionToken, type Type } from '@angular/core';

/**
 * The component that offers to install a Catalog Agent (required input `agent: Agent`). Features never import each
 * other, so a view that embeds the offer (Settings, new Session, Agent bar) renders it with `NgComponentOutlet`
 * from this token; the app provides the component (`app.config.ts`).
 */
export const AGENT_INSTALL_OFFER = new InjectionToken<Type<unknown>>('AGENT_INSTALL_OFFER');
