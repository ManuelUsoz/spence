# spence

![Spence banner](build/banner.png)

Electron desktop app with an Angular renderer, Effect for domain logic and Spartan UI (helm) components.

```
npm install
npm run dev        # renderer + electron
npm run verify     # format, types, lint, tests (the loop)
npm run e2e        # build + Playwright against the real app
```

Read `CLAUDE.md` for the map and `AGENTS.md` for the rules.

## Releases and updates

Set the version in `package.json` and `package-lock.json` (for example, with `npm version 0.1.0-rc.1 --no-git-tag-version`), commit it, then push a matching tag such as `v0.1.0-rc.1` or `v0.1.0`. GitHub Actions builds the Windows Squirrel and Ubuntu x64 packages and publishes the release after both builds succeed. Numbered RC tags become GitHub prereleases; all releases share one update stream. Versions must increase, and RC numbers are limited to eight digits.

In Settings > About, **Check for updates** looks for the newest complete release, including prereleases, and downloads it. On Windows, Squirrel installs the update. On Ubuntu, Spence verifies the downloaded package and asks for administrator authentication through PolicyKit before installing it with apt. Confirming an update can stop running work; Spence checks before restarting.

On Windows, `npm run package` builds the installer and update files. On Ubuntu, install `dpkg` and `fakeroot`, run `npm ci`, then `npm run build` and `npx electron-forge make --targets=@electron-forge/maker-deb --arch=x64`. Install the generated package with `sudo apt install ./out/make/deb/x64/<package>.deb`.
