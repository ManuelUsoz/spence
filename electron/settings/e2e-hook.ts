import { Effect, Schema } from 'effect';
import { SettingsPatch } from '../../src/shared/settings/settings.rpc';
import { MainRuntime } from '../rpc/runtime';
import { Settings } from './settings';

/** What an e2e spec reaches with `app.evaluate(() => globalThis.spenceE2E...)`. */
export interface SpenceE2EHook {
  /** `Settings.update` exactly as the renderer calls it, for flows whose UI does not exist yet. */
  readonly updateSettings: (patch: unknown) => Promise<void>;
}

/** Installs the e2e hook on main's global object. Only for `SPENCE_E2E=1`; a normal launch never has it. */
export const installE2EHook = (): void => {
  if (process.env['SPENCE_E2E'] !== '1') return;
  const hook: SpenceE2EHook = {
    updateSettings: (patch) =>
      MainRuntime.runPromise(
        Schema.decodeUnknownEffect(SettingsPatch)(patch).pipe(
          Effect.orDie,
          Effect.flatMap((decoded) => Settings.use((settings) => settings.update(decoded))),
          Effect.asVoid,
        ),
      ),
  };
  Object.assign(globalThis, { spenceE2E: hook });
};
