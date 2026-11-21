import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import type { UpdateInfo } from '../../../../shared/updates/updates.rpc';
import { UpdatesState } from '../updates-state';
import { SettingsRow } from './settings-row';

/** How much of the artifact has arrived, as a whole percentage. */
const percentOf = (received: number, total: number): number =>
  total <= 0 ? 0 : Math.min(100, Math.round((received / total) * 100));

const dateOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

/** The release's notes and known issues, shown identically wherever an update is displayed. */
@Component({
  selector: 'app-release',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="font-mono text-xs" data-testid="updates-release-version">
      {{ info().version }} · {{ dateOf(info().releasedAt) }}
    </p>
    <p class="mt-1 text-xs whitespace-pre-line" data-testid="updates-release-notes">
      {{ info().releaseNotes }}
    </p>
    @if (info().knownIssues !== '') {
      <p class="text-muted-foreground mt-2 text-xs" data-testid="updates-known-issues">
        <span class="font-medium" i18n>Known issues</span>
        <span class="whitespace-pre-line"> {{ info().knownIssues }}</span>
      </p>
    }
  `,
})
export class UpdateRelease {
  readonly info = input.required<UpdateInfo>();
  protected readonly dateOf = dateOf;
}

/**
 * Updates: the beta channel, what main last checked, and the verified download waiting for a restart. Main owns
 * the updater; this only asks and shows. Release notes come from the signed manifest, never from the page.
 */
@Component({
  selector: 'app-settings-updates',
  imports: [SettingsRow, HlmButtonImports, UpdateRelease],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Updates</h2>

    <app-settings-row
      label="Channel"
      i18n-label
      hint="Beta receives beta releases and, later, stable ones. There is no stable channel yet."
      i18n-hint
    >
      <span class="font-mono text-xs" i18n>Beta</span>
    </app-settings-row>

    <div class="border-border/60 border-t py-3 text-sm" data-testid="settings-updates">
      @switch (state()._tag) {
        @case ('Idle') {
          <p class="text-muted-foreground" i18n>
            Beta updates are checked at startup and every 24 hours while Spence is open.
          </p>
        }
        @case ('Checking') {
          <p class="text-muted-foreground" data-testid="updates-checking" i18n>
            Checking for updates…
          </p>
        }
        @case ('UpToDate') {
          <p class="text-muted-foreground" data-testid="updates-up-to-date" i18n>
            Spence is up to date.
          </p>
        }
        @case ('Available') {
          <div data-testid="updates-available">
            @if (release(); as info) {
              <app-release [info]="info" />
            }
            <div class="mt-2 flex items-center gap-2">
              <button
                hlmBtn
                type="button"
                size="sm"
                data-testid="updates-download"
                (click)="download()"
                i18n
              >
                Download update
              </button>
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="sm"
                data-testid="updates-open-release"
                (click)="openRelease()"
                i18n
              >
                Release notes
              </button>
            </div>
          </div>
        }
        @case ('Downloading') {
          <div data-testid="updates-downloading">
            <p class="text-muted-foreground" i18n>Downloading the update in the background…</p>
            <div
              class="bg-muted mt-2 h-1.5 w-full overflow-hidden rounded-full"
              role="progressbar"
              [attr.aria-valuenow]="percent()"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="bg-primary h-full rounded-full" [style.width.%]="percent()"></div>
            </div>
            <p class="text-muted-foreground mt-1 font-mono text-xs tabular-nums">
              {{ percent() }}%
            </p>
          </div>
        }
        @case ('Ready') {
          <div data-testid="updates-ready">
            @if (release(); as info) {
              <p data-testid="updates-ready-version">
                <span i18n>Update</span>
                <span class="font-mono text-xs"> {{ info.version }} </span>
                <span i18n>is ready. It installs when you restart.</span>
              </p>
              <app-release [info]="info" />
            }
            <div class="mt-2 flex items-center gap-2">
              <button
                hlmBtn
                type="button"
                size="sm"
                data-testid="updates-restart"
                (click)="restart()"
                i18n
              >
                Restart to update
              </button>
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="sm"
                data-testid="updates-open-release"
                (click)="openRelease()"
                i18n
              >
                Release notes
              </button>
            </div>
          </div>
        }
        @case ('Failed') {
          <div data-testid="updates-failed">
            <p class="text-destructive">{{ failureTitle() }}</p>
            <p class="text-muted-foreground mt-1 text-xs" data-testid="updates-failure-detail">
              {{ failureDetail() }}
            </p>
            @if (release(); as info) {
              <app-release [info]="info" />
            }
            <div class="mt-2 flex items-center gap-2">
              <button
                hlmBtn
                type="button"
                size="sm"
                data-testid="updates-check"
                (click)="check()"
                i18n
              >
                Try again
              </button>
              @if (release() !== null) {
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="updates-open-release"
                  (click)="openRelease()"
                  i18n
                >
                  Release notes
                </button>
              }
            </div>
          </div>
        }
      }

      @if (problem(); as detail) {
        <p class="text-destructive mt-2 text-xs" data-testid="updates-problem">{{ detail }}</p>
      }

      @if (
        !busy() &&
        state()._tag !== 'Ready' &&
        state()._tag !== 'Available' &&
        state()._tag !== 'Failed'
      ) {
        <button
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          class="mt-2"
          data-testid="updates-check"
          (click)="check()"
          i18n
        >
          Check for updates
        </button>
      }

      <p class="text-muted-foreground mt-3 text-xs" i18n>
        Windows installers are unsigned, so Windows may warn when you install or update. Your
        Sessions and Settings are kept across updates.
      </p>
    </div>
  `,
})
export class SettingsUpdates {
  protected readonly updates = inject(UpdatesState);
  protected readonly state = this.updates.state;
  protected readonly busy = this.updates.busy;
  protected readonly problem = this.updates.problem;
  protected readonly failureDetail = computed(() => {
    const state = this.state();
    return state._tag === 'Failed' ? state.detail : '';
  });
  protected readonly release = computed((): UpdateInfo | null => {
    const state = this.state();
    switch (state._tag) {
      case 'Available':
      case 'Downloading':
      case 'Ready':
        return state.info;
      case 'Failed':
        return state.info ?? null;
      case 'Idle':
      case 'Checking':
      case 'UpToDate':
        return null;
    }
  });
  protected readonly percent = computed(() => {
    const state = this.state();
    return state._tag === 'Downloading' ? percentOf(state.receivedBytes, state.totalBytes) : 0;
  });
  protected readonly failureTitle = computed((): string => {
    const state = this.state();
    if (state._tag !== 'Failed') return '';
    switch (state.reason) {
      case 'CheckFailed':
        return $localize`Could not check for updates.`;
      case 'DownloadFailed':
        return $localize`The download failed.`;
      case 'VerificationFailed':
        return $localize`The update could not be verified and was discarded.`;
      case 'NotWritable':
        return $localize`Spence cannot replace its AppImage here.`;
      case 'InstallFailed':
        return $localize`The update could not be installed.`;
      case 'Unsupported':
        return $localize`Updates are not available for this build.`;
    }
  });

  protected check(): void {
    void this.updates.check();
  }

  protected download(): void {
    void this.updates.download();
  }

  protected restart(): void {
    void this.updates.restart();
  }

  protected openRelease(): void {
    const info = this.release();
    if (info !== null) void this.updates.openRelease(info.releaseUrl);
  }
}
