/**
 * The update feed: the maintainer's public repository. Nothing else is trusted (spec §15, §22).
 */
export const UPDATE_OWNER = 'ManuelUsoz';
export const UPDATE_REPO = 'spence';

/**
 * The raw Ed25519 public key (base64, 32 bytes) that verifies `update-manifest.sig`. The private key never
 * enters this repository or CI: it stays offline and is used by the helper described in
 * docs/offline-beta-update-proof.md. Replacing it requires shipping a build with the new key; the previous one is not trusted.
 *
 * A build with an empty key checks nothing and installs nothing: it fails closed.
 */
export const UPDATE_SIGNING_PUBLIC_KEY = '';
