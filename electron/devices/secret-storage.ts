import { Context, Effect, Layer } from 'effect';

/** A secret as the OS keeps it: what `seal` returned, opened again. */
export interface OpenedSecret {
  readonly plain: string;
  /** The OS rotated its key: seal `plain` again and store the new form. */
  readonly stale: boolean;
}

export interface SecretStorageShape {
  /**
   * Whether the OS can keep secrets safely here (DPAPI, Keychain, a Linux keyring). When it cannot, nothing secret
   * is stored at all: Pairing is refused, never kept in plaintext.
   */
  readonly available: Effect.Effect<boolean>;
  /** Encrypts a secret for this OS user; the result (base64) may be written to disk. */
  readonly seal: (plain: string) => Effect.Effect<string>;
  /** Decrypts what `seal` returned. A blob this OS user cannot open is a defect. */
  readonly open: (sealed: string) => Effect.Effect<OpenedSecret>;
}

/** The OS secret storage that Pairing keeps tokens and pinned fingerprints in. Main only. */
export class SecretStorage extends Context.Service<SecretStorage, SecretStorageShape>()(
  'devices/SecretStorage',
) {}

const FAKE_PREFIX = 'fake-sealed:';

/**
 * A stand-in for tests (and the e2e runs on machines without a keyring): it only encodes, it protects nothing.
 * `available: false` behaves as a Linux without a keyring.
 */
export const layerSecretStorageFake = (options: { readonly available: boolean }) =>
  Layer.succeed(SecretStorage, {
    available: Effect.succeed(options.available),
    seal: (plain) =>
      options.available
        ? Effect.succeed(FAKE_PREFIX + Buffer.from(plain, 'utf8').toString('base64'))
        : Effect.die('secret storage is unavailable'),
    open: (sealed) =>
      sealed.startsWith(FAKE_PREFIX)
        ? Effect.succeed({
            plain: Buffer.from(sealed.slice(FAKE_PREFIX.length), 'base64').toString('utf8'),
            stale: false,
          })
        : Effect.die('not sealed by this secret storage'),
  });
