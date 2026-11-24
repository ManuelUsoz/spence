import type { NgComponentOutlet } from '@angular/common';
import { effect, InjectionToken, type Type } from '@angular/core';

/**
 * The component that offers to install a Catalog Agent (required input `agent: Agent`). Features never import each
 * other, so a view that embeds the offer (Settings, new Session, Agent bar) renders it with `NgComponentOutlet`
 * from this token; the app provides the component (`app.config.ts`).
 */
export const AGENT_INSTALL_OFFER = new InjectionToken<Type<unknown>>('AGENT_INSTALL_OFFER');

interface InstallOfferInstance {
  readonly installed?: {
    subscribe: (next: () => void) => { unsubscribe: () => void };
  };
}

/** Subscribes to `(installed)` on any `AGENT_INSTALL_OFFER` `NgComponentOutlet` until replaced or destroyed. */
export const onInstallOfferInstalled = (
  outlets: () => NgComponentOutlet | ReadonlyArray<NgComponentOutlet> | undefined,
  onInstalled: () => void,
): void => {
  effect((onCleanup) => {
    const value = outlets();
    const list: ReadonlyArray<NgComponentOutlet> =
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    const subs = list.flatMap((outlet) => {
      const instance = outlet.componentInstance as InstallOfferInstance | null | undefined;
      return instance?.installed ? [instance.installed.subscribe(onInstalled)] : [];
    });
    onCleanup(() => {
      for (const sub of subs) sub.unsubscribe();
    });
  });
};
