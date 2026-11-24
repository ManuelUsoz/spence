import { effect, Injectable, inject, untracked } from '@angular/core';
import { toast } from '@ui/toast';
import {
  AgentInstallTracker,
  type BackgroundInstallFailure,
} from '../../core/agent-install-tracker';

const failureTitle = (failure: BackgroundInstallFailure): string => {
  const name = failure.agent.name;
  switch (failure.reason) {
    case 'RuntimeDownloadFailed':
      return $localize`Couldn't download the Node runtime for ${name}:name:.`;
    case 'ChecksumMismatch':
      return $localize`The downloaded Node runtime failed verification.`;
    case 'PermissionDenied':
      return $localize`Spence isn't allowed to write to its agent folder.`;
    case 'NpmFailed':
      return $localize`Couldn't install ${name}:name:.`;
    case 'NotOnPath':
      return $localize`${name}:name: wasn't found on PATH.`;
    case 'Unreachable':
      return $localize`The setup couldn't be started.`;
  }
};

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
    toast.error(failureTitle(failure), {
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
    });
  }
}
