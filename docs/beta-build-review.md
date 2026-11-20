# Beta build review

The **Beta build for review** workflow is manually dispatched against the commit selected in GitHub Actions. It builds Windows x64 NSIS and Linux x64 AppImage candidates on GitHub-hosted runners, with read-only repository permissions. Download both artifacts from the same successful run and record its commit SHA and run URL in the review. These artifacts expire after 14 days; they are review candidates, not releases.

Run the repository verification gate for that exact commit and review its results before testing the artifacts. On real Windows and Linux machines, install and exercise each candidate, including an upgrade from an older installed build, Store data preservation, and failure recovery. Record platform versions, results, and known issues. The Windows installer is unsigned and Windows may display a warning.

Publication is disabled. Do not publish these candidates or generated update metadata until the offline signing and verification workflow has been demonstrated, beta channel configuration and matching metadata have been validated, and real-platform update testing has passed. A checksum distributed alongside an artifact does not authenticate it. Keep private signing material out of GitHub Actions and untrusted pull requests.

Once those prerequisites are addressed in a separately reviewed publication process, the maintainer must deliberately approve publication and supply beta release notes, known issues, and the unsigned Windows notice. A successful build alone must never publish a release.
