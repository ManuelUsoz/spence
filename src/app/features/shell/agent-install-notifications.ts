import { effect, Injectable, inject, untracked } from '@angular/core';
import { toast } from '@ui/toast';
import {
  AgentInstallTracker,
  installFailureMessage,
  isAgentUpdate,
  type BackgroundInstallFailure,
} from '../../core/agent-install-tracker';

/**
 * Surfaces `AgentInstallTracker` background failures as non-blocking error toasts when a setup job
 * fails after its originating `AgentInstallOffer` view has unmounted. Never raises Attention.
 */
@Injectable()
export class AgentInstallNotifications {
  private readonly tracker = inject(AgentInstallTracker);

  constructor() {
    effect(() => {
      const failures = this.tracker.backgroundFailures();
      if (failures.length === 0) return;
      untracked(() => {
        for (const failure of failures) {
          this.tracker.dismissBackgroundFailure(failure.id);
          this.show(failure);
        }
      });
    });
  }

  private show(failure: BackgroundInstallFailure): void {
    toast.error(
      installFailureMessage(failure.reason, failure.agent.name, isAgentUpdate(failure.agent)),
      {
        duration: 15_000,
        testId: 'agent-install-error-toast',
        ...(failure.detail !== '' ? { description: failure.detail } : {}),
        action: {
          label: $localize`Try again`,
          onClick: () => this.tracker.start(failure.agent, failure.device),
        },
        ...(failure.hasLog && failure.device === undefined
          ? {
              cancel: {
                label: $localize`Open log`,
                onClick: () => void this.tracker.openLog(),
              },
            }
          : {}),
      },
    );
  }
}
