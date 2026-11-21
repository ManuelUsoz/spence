# Offline-signed beta update release gate

Status: **not demonstrated on real platforms; automatic installation is blocked**. The signed-manifest
updater (`electron/updates/`, `src/shared/updates/`, `SettingsUpdates`) is integrated in this
checkout and fails closed because `UPDATE_SIGNING_PUBLIC_KEY` in `electron/updates/public-key.ts`
is empty until real-platform proof is completed. Do not enable installation based on a checksum
downloaded from the same release host as the artifact.

The lockfile selects electron-builder 26.18.0; Spence uses a custom Ed25519-signed
`update-manifest.json` + `update-manifest.sig` updater rather than `electron-updater`.
Windows NSIS and Linux AppImage need separate end-to-end evidence against a real GitHub beta
release.

## Evidence required before enabling installation

Record the exact source commit, operating system, architecture, builder and updater
versions, channel configuration, release identifiers and artifact hashes with the
results. Use disposable test keys and a controlled GitHub beta release. Exercise the
actual packaged updater and installer, not a separate signature example.

1. Build an older installed version and a newer beta for each platform. Sign the
   exact metadata and artifact binding offline, with the private key unavailable to
   CI. Publish the resulting test assets through the intended GitHub release flow.
2. Show that the older installation discovers the beta, verifies metadata and the
   artifact, and installs only after the user chooses restart. Verify Sessions and
   Settings survive, and ordinary quit does not install.
3. Independently alter metadata, the signature, and artifact bytes. Each must be
   rejected by the real updater before installation, including after restart or a
   retry. Record the observed error and prove the installed version remains usable.
4. Demonstrate beta receiving a newer stable release as well as a beta; establish
   explicit GitHub channel configuration and no downgrade. Test failure recovery and
   a non-writable AppImage location on Linux.
5. Review the trust boundary, including replay/rollback, key selection, artifact
   substitution and the path from verification to the bytes actually installed.
   Document any remaining gaps and keep installation disabled until resolved.

## Key custody and recovery

Generate the production signing key on a trusted offline machine, never in GitHub
Actions or an untrusted pull request. Protect it with an encrypted offline backup
stored separately; periodically verify that backup can be recovered without exposing
it to CI. Limit access and document custodians and the recovery procedure privately.
Never commit private key material or publish it with release assets.

Plan rotation before a key expires or is suspected compromised: distribute a new
public trust key in a version authenticated by an existing trusted key, verify its
deployment, then switch signing and retire the old key. This requires an implemented
and tested trust transition; it is not yet available. If the old key is compromised,
the host cannot be trusted to deliver a safe transition by itself. If all trusted
private copies are lost, users may need to manually install a newly trusted version
through an independently authenticated channel. Rehearse both cases before release.

## Offline signing helper (experimental)

On a trusted offline machine, place the exact `update-manifest.json` and both release
artifacts in a staging directory. The manifest uses the updater's proposed schema:
`version`, `channel` (`beta`), `releasedAt`, `releaseUrl`, `releaseNotes`,
`knownIssues`, and `artifacts` entries for `win-x64` and `linux-x64`, each with an
HTTPS `url`, base64 SHA-512 `sha512`, and positive byte `sizeBytes`. The final URL
path component must match the local artifact filename. Review the metadata and URLs
independently before signing; this helper does not establish their correctness.

With an offline directory outside the repository, generate the Ed25519 keypair once:

```sh
node scripts/offline-update-keygen.mjs /path/to/offline-keys
```

This writes `private.pem` (PKCS#8) and `public.pem` (SPKI), refuses to overwrite existing keys or write inside a Git repo, and prints the 32-byte raw base64 public key for `UPDATE_SIGNING_PUBLIC_KEY` in `electron/updates/public-key.ts`.

With the generated `/path/to/offline-keys/private.pem`, run:

```sh
node scripts/offline-update-sign.mjs sign /path/to/staging /path/to/offline-keys/private.pem
node scripts/offline-update-sign.mjs verify /path/to/staging /path/to/offline-keys/public.pem
```

The public key is an Ed25519 SPKI PEM. Signing validates both staged artifacts and
writes a new `update-manifest.sig` containing a base64 signature of the exact JSON
bytes; it refuses to overwrite an existing signature. Verification checks that
signature first, then both artifact sizes and hashes. Transfer only the manifest,
signature and artifacts for publication; re-run verification on the transferred files
using an independently trusted public key immediately before publication. Do not
transfer the private key. Never run signing in CI. Protect and back up the key as
specified above. This helper does not publish, enforce offline operation, establish
key trust, prevent replay, or prove that installed bytes match verified bytes. It does
not integrate an updater or validate GitHub channels or either platform. Automatic
installation remains blocked pending the evidence above.
