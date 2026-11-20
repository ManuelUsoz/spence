# Offline-signed beta update release gate

Status: **not demonstrated; automatic installation is blocked**. This document is a
release gate, not evidence that the updater verifies signatures. The integration
work in progress is not present in this checkout. Do not enable installation based
on a checksum downloaded from the same release host as the artifact.

The lockfile selects electron-builder 26.18.0; this checkout does not depend on
electron-updater. Neither compatibility with a signed metadata scheme nor GitHub
beta channel behavior has been established for a selected updater/builder pair.
Windows NSIS and Linux AppImage need separate end-to-end evidence.

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
