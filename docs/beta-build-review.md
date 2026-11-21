# Beta build review

The **Beta build for review** workflow is manually dispatched against the commit selected in GitHub Actions. It builds Windows x64 NSIS and Linux x64 AppImage candidates on GitHub-hosted runners, with read-only repository permissions. Download both artifacts from the same successful run and record its commit SHA and run URL in the review. These artifacts expire after 14 days; they are review candidates, not releases.

Run the repository verification gate for that exact commit and review its results before testing the artifacts. On real Windows and Linux machines, install and exercise each candidate, including an upgrade from an older installed build, Store data preservation, and failure recovery. Record platform versions, results, and known issues. The Windows installer is unsigned and Windows may display a warning.

Publication is disabled. Do not publish these candidates or generated update metadata until the offline signing and verification workflow has been demonstrated, beta channel configuration and matching metadata have been validated, and real-platform update testing has passed. A checksum distributed alongside an artifact does not authenticate it. Keep private signing material out of GitHub Actions and untrusted pull requests.

Once those prerequisites are addressed and real-platform testing has passed, use the staged release helper to prepare and verify a deliberate beta publication:

1. Download both review artifacts (`beta-review-Windows-x64` and `beta-review-Linux-x64`) from the same successful **Beta build for review** run into a clean staging folder.
2. Generate `update-manifest.json` with `node scripts/beta-release.mjs prepare <staging-dir> --version <semver> --notes-file <notes.md> [--known-issues <text>]` (this enforces `channel: "beta"` and includes the unsigned Windows installer notice).
3. Transfer the staging folder to the offline signing machine and run `node scripts/offline-update-sign.mjs sign <staging-dir> /offline/private.pem`.
4. Transfer only `update-manifest.sig` back (never the private key), then publish deliberately after verifying with the trusted public key: `node scripts/beta-release.mjs publish <staging-dir> /path/to/public.pem`. A successful build alone must never publish a release.
