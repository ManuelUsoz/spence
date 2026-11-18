import { app, safeStorage } from 'electron';
import { Effect, Layer } from 'effect';
import { layerSecretStorageFake, SecretStorage } from './secret-storage';

/** Electron's asynchronous `safeStorage`, after the app is ready (the synchronous API is deprecated). */
const layerSecretStorageElectron = Layer.succeed(SecretStorage, {
  available: Effect.promise(async () => {
    await app.whenReady();
    // Linux without a keyring falls back to a hard-coded key ('basic_text'): as good as plaintext, so refused.
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return false;
    }
    return safeStorage.isAsyncEncryptionAvailable();
  }),
  seal: (plain) =>
    Effect.promise(async () => {
      await app.whenReady();
      return (await safeStorage.encryptStringAsync(plain)).toString('base64');
    }),
  open: (sealed) =>
    Effect.promise(async () => {
      await app.whenReady();
      const opened = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));
      return { plain: opened.result, stale: opened.shouldReEncrypt };
    }),
});

/**
 * The OS secret storage. Under e2e only, `SPENCE_E2E_SECRET_STORAGE` swaps in the fake (`fake`, for CI runners with
 * no keyring) or a missing one (`unavailable`); a normal run always uses `safeStorage`.
 */
export const layerSecretStorageLive = Layer.suspend(() => {
  if (process.env['SPENCE_E2E'] !== '1') return layerSecretStorageElectron;
  const choice = process.env['SPENCE_E2E_SECRET_STORAGE'];
  if (choice === 'fake') return layerSecretStorageFake({ available: true });
  if (choice === 'unavailable') return layerSecretStorageFake({ available: false });
  return layerSecretStorageElectron;
});
