# Windows and Linux beta packages

Build from a clean checkout on the target x64 OS with Node 24 and npm. Install dependencies with `npm ci`, then run `npm run verify`. The lockfile pins dependencies; electron-builder may download platform tools and Electron binaries. The output is in `release/`.

On Windows, run `npm run package -- --win nsis --x64 --publish never`. Run the resulting `Spence Setup*.exe` to install. The beta installer is unsigned: Windows SmartScreen may warn that the publisher is unknown. Only proceed if you trust the source of the installer.

On Linux, run `npm run package -- --linux AppImage --x64 --publish never`. Make the resulting AppImage executable (`chmod +x release/*.AppImage`) and launch it from a desktop file manager or terminal. AppImage support depends on the distribution; FUSE may be required.

These commands build locally and do not publish a release. A successful build alone does not establish that a package is ready for testers. Before distributing each version, on real Windows and Linux x64 systems:

1. Install or run an older packaged build and create a Session and change a setting. Back up the test data.
2. Quit Spence, install the new Windows build over the old one or replace the Linux AppImage, and launch it. Confirm the Session and setting remain intact and usable.
3. Record OS version, package filename, version, checksum, launch and preservation results. Investigate failures before distribution. Keep the backup until validation is complete.

This manual replacement check does not validate automatic updates, authenticity of update metadata, or installer recovery. Those require separate release qualification.
