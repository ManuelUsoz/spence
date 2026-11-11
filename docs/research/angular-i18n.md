# Research: Angular built-in i18n inside Electron

Ticket: #5 (map #1). Researched 2026-11-11 against the installed versions:
`@angular/core` 22.2.5, `@angular/build` / `@angular/cli` 22.2.6, `@angular/localize` 22.2.5 (not yet
installed; package inspected via `npm pack`), `electron` 45.3.0, `electron-builder` 26.18.0.

Already decided (map #1): `@angular/localize`, English + standard Spanish (`es`), switching language
reloads the window into the other locale build. Agent output is never translated.

Sources are cited inline as **[S#]** and listed at the end. "Source" means code under `node_modules`
unless it is a URL.

## TL;DR

1. One `ng build` with `localize: true` compiles once, then inlines each locale into a copy of the
   bundle in its own subfolder: `dist/renderer/en/` and `dist/renderer/es/`. There is no longer a
   `dist/renderer/index.html` [S1][S2].
2. **Trap:** with our `baseHref: "./"`, the builder appends the locale subPath, so `es/index.html`
   gets `<base href="./es/">`, which under `file://` resolves to `dist/renderer/es/es/` and breaks
   every asset. Set `"baseHref": ""` on each locale entry to keep `./` [S3].
3. Translations are inlined at build time: no runtime fetch, no inline script, so the CSP in
   `src/index.html` needs no change. The builder sets `<html lang>` per locale [S2][S4].
4. Electron main picks the folder: stored override, else `app.getPreferredSystemLanguages()`, else
   English. Switching = persist + `mainWindow.loadFile(<other>/index.html)`. The existing handshake
   already rebinds a fresh port on reload, and `will-navigate` does not fire for `loadFile` [S5][S6].
5. `ng serve` serves only one locale; with several it warns and disables localization [S7]. Dev is
   English by default; Spanish needs its own serve configuration, and switching in dev means
   restarting the dev server.
6. `ng extract-i18n` works without adding a target (CLI defaults to `@angular/build:extract-i18n`)
   and writes only the source file (default XLIFF 1.2). Keeping `messages.es.xlf` in sync is manual
   or needs our own Node script [S8][S9].
7. Missing translations are a **warning** by default and only surface in `ng build`, which
   `npm run verify` never runs. Set `i18nMissingTranslation: "error"` and add a verify step [S10].
8. Unit tests build with `localize: false` and auto-import `@angular/localize/init`, so specs see the
   English source text; no spec changes needed [S11].
9. e2e must pin the locale (the OS language of the machine running Playwright otherwise decides the
   screenshots), and baselines double if Spanish states are shot.
10. Packaging: `files: dist/renderer/**` already covers both folders. If we ever prune Chromium
    locales with `electronLanguages`, keep `en-US` and `es`; `getPreferredSystemLanguages` reads the
    OS and does not depend on them [S12][S13].

## 1. Installing `@angular/localize`

`ng add @angular/localize` (schematic in `@angular/localize/schematics/ng-add`) does exactly this [S14]:

- Adds `"@angular/localize/init"` to `polyfills` of `build` targets (`@angular/build:application`).
  Note it does **not** touch the `@angular/build:unit-test` target; the test runner imports it on
  its own (section 7).
- Adds `"@angular/localize"` to `compilerOptions.types` in each target's `tsConfig`
  (`tsconfig.app.json`, which today has `"types": []`) and in the unit-test tsconfig
  (`tsconfig.spec.json`).
- Prepends `/// <reference types="@angular/localize" />` to `src/main.ts`.
- Installs as a devDependency; `--use-at-runtime` moves it to `dependencies`. We do not need runtime
  `$localize` (everything is inlined at build), so devDependency is right. Its own deps include
  `@babel/core` 8 (build-time only).

`npm run typecheck:app` and `typecheck:spec` then type `$localize`. `tsconfig.electron.json` is not
affected (main never uses `$localize`).

Prefer running the schematic (`npx ng add @angular/localize --skip-confirmation`) over hand edits,
then review the diff.

## 2. `angular.json`

How the builder reads `projects.spence.i18n` [S1]:

- `sourceLocale`: string or `{ code, baseHref, subPath }`; default `en-US`.
- `locales.<id>`: a translation path (string or array) or `{ translation, baseHref, subPath }`.
- `subPath` (default: the locale code) is the output folder name and the default base href suffix;
  only `[\w-]` allowed; `subPath` and `baseHref` cannot both be set on one locale.
- A locale cannot be both source and translated.

How the output is laid out [S2]: for each inlined locale the output files and assets are moved under
`<subPath>/` (unless `i18n.flatOutput`), and the post-bundle step (index.html) runs per locale with
`baseHref = getLocaleBaseHref(baseHref, i18n, locale) ?? baseHref`.

`getLocaleBaseHref` [S3] joins the build `baseHref` with `locale.baseHref ?? subPath + '/'`, and
returns `undefined` (so the build `baseHref` is kept) when that suffix is `''`. Checked by calling it
directly:

```
getLocaleBaseHref('./', { es: { subPath: 'es' } }, 'es')            -> "./es/"     (broken under file://)
getLocaleBaseHref('./', { en: { subPath: 'en', baseHref: '' } }, 'en') -> undefined  (keeps "./")
```

Proposed config (source locale `en` so its folder is `en/`, not `en-US/`):

```jsonc
"spence": {
  "i18n": {
    "sourceLocale": { "code": "en", "baseHref": "" },
    "locales": {
      "es": { "translation": "src/locale/messages.es.xlf", "baseHref": "" }
    }
  },
  "architect": {
    "build": {
      "options": {
        "localize": true,
        "i18nMissingTranslation": "error",   // default "warning" [S10]
        "polyfills": ["@angular/localize/init"],   // added by ng add; stripped when inlining [S4]
        ...
      },
      "configurations": {
        "development": { "localize": false },          // or ["en"]; see section 5
        "es": { "localize": ["es"] }                    // for `ng serve -c development,es`
      }
    },
    "serve": {
      "configurations": {
        "es": { "buildTarget": "spence:build:development,es" }
      }
    },
    "extract-i18n": {
      "builder": "@angular/build:extract-i18n",
      "options": { "buildTarget": "spence:build", "outputPath": "src/locale", "format": "xlf" }
    }
  }
}
```

Notes:

- `localize` accepts `true` (all), an array of locale ids, or `false` [S15].
- When inlining, the build removes `@angular/localize/*` polyfills and appends
  `$localize.locale = "<id>"` per locale; when not inlining but `sourceLocale` is defined, it injects
  the source locale and its locale data [S4].
- Locale data (`@angular/common/locales/es`) is added automatically per locale by the inliner
  (`loadLocaleData(locale)`); no `registerLocaleData` call needed [S16]. `en` data is built into core.
- `LOCALE_ID` defaults from `$localize.locale`, which each localized build sets; do not provide
  `LOCALE_ID` ourselves or `$localize.locale` will not reflect it [S17]. Date/number/currency pipes
  then format per locale for free.
- `es` is a valid Angular locale (`@angular/common/locales/es.js` exists, alongside `es-419`): it is
  the "standard Spanish" the map asks for.
- `budgets` apply to each locale's output; Spanish strings are slightly longer, negligible.
- Build cost: one compile, then one inlining pass per locale (worker pool, cached) [S2].

## 3. Electron main: choosing and switching the build

Today `electron/main.ts` does `loadFile(path.join(__dirname, '../dist/renderer/index.html'))`.
That file no longer exists after section 2. New shape:

```ts
type Locale = 'en' | 'es';
const rendererIndex = (locale: Locale) =>
  path.join(__dirname, '../dist/renderer', locale, 'index.html');
```

Picking the locale at startup (after `ready`):

1. Stored override (Settings ticket owns where; e.g. a JSON in `app.getPath('userData')`, which e2e
   already isolates via `SPENCE_USER_DATA`).
2. Else the first entry of `app.getPreferredSystemLanguages()` whose language subtag is `es` -> `es`,
   otherwise `en`. Only the language subtag matters (`es-419`, `es-AR`, `es-ES`, `es` all map to `es`).
3. Else `en`.

Which Electron API [S12]:

- `app.getPreferredSystemLanguages()`: "user's preferred system languages from most preferred to
  least preferred, including the country codes if applicable"; Windows uses `GlobalizationPreferences`
  (fallback `GetSystemPreferredUILanguages`), macOS `[NSLocale preferredLanguages]`, Linux
  `g_get_language_names`. The typings say it "can be used for purposes such as deciding what
  language to present the application in". On Windows an entry may lack a country code. **Use this.**
- `app.getLocale()`: Chromium's `l10n_util` app locale; must be called after `ready`; requires the
  packaged `locales` folder; settable with the `--lang` switch. It reflects Chromium's UI locale, not
  necessarily the user's language list.
- `app.getSystemLocale()`: the regional-format locale (can differ from UI language); after `ready`.

Optional: `app.commandLine.appendSwitch('lang', locale)` before `ready` aligns Chromium's own UI
(context menus, `navigator.language`) with our choice [S18]. It must run before `ready`, so it needs
the override read synchronously at startup, and a language switch would only affect Chromium after an
app restart. Decide in the Settings ticket; not needed for Angular.

Switching language at runtime:

- Renderer calls an RPC (Settings domain, e.g. `Settings.setLanguage`), main persists the override,
  then calls `mainWindow.loadFile(rendererIndex(next))`. Main drives it, so the renderer needs no
  file paths and no new preload surface.
- `will-navigate` is not emitted for navigations started with `webContents.loadURL` and similar
  programmatic APIs [S6], so the guard in `main.ts` is unaffected. Anything still on `file://`
  passes it anyway.
- The handshake (`electron/ipc/handshake.ts`) checks `frame.url.startsWith('file://')` and already
  documents "A new connect (reload) replaces the previous port" [S5]. `src/app/core/desktop-port.ts`
  reconnects on every load. No transport change.
- Renderer state is lost on reload; the Sessions/transcript design must restore from main anyway.
- In dev (`ELECTRON_RENDERER_URL`), main loads the dev server URL regardless of locale (section 5).

## 4. CSP

`src/index.html` CSP: `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, ...

- Translations are inlined into the JS at build time (`I18nInliner` rewrites `$localize` call sites
  and the `___NG_LOCALE_INSERT___` placeholder) [S4][S16]. Nothing is fetched or `eval`ed at runtime.
- The per-locale `index.html` is the same template with `lang` (and `dir`) updated
  (`augment-index-html.js`: `updateAttribute(tag, 'lang', lang)`) [S19]. Our hard-coded
  `<html lang="en">` becomes `lang="es"` in the Spanish build. The CSP `<meta>` is copied unchanged.
- `optimization.styles.inlineCritical: false` must stay (CLAUDE.md); i18n does not change that.

Conclusion: no CSP change.

## 5. Dev server

`@angular/build:dev-server` [S7]: if `localize` is `true` or an array with more than one locale it
logs "Localization (`localize` option) has been disabled. The development server only supports
localizing a single locale per build." and sets `localize = false`. A single locale works, including
template HMR (only the first locale is inlined for HMR updates [S2]).

So:

- `npm run dev` keeps serving English source text with `localize: false` in `development`
  (`$localize` from the polyfill returns the source text).
- Add `serve -c es` (build config `development,es`) for working on Spanish, e.g. a
  `dev:es` script. Switching language from the UI in dev cannot load "the other build"; main should
  just reload the dev URL (or ignore the switch) in dev.

## 6. Extracting and maintaining en/es messages

- `ng extract-i18n` with no `extract-i18n` target falls back to `@angular/build:extract-i18n` for
  `@angular/build:application` projects [S8]. Adding the target is still useful to pin
  `outputPath`/`format`.
- Options [S9]: `buildTarget` (default `:build`), `format` (default `xlf`; also `xlf2`/`xliff2`,
  `json`, `arb`, `xmb`, `legacy-migrate`), `outputPath`, `outFile`, `i18nDuplicateTranslation`.
- It writes only the source file (`messages.xlf`). Angular ships no merge into existing translation
  files [S20]. The guide's workflow is: copy the source file to `messages.es.xlf` and translate.
  After every text change: re-extract, then add/update units in `messages.es.xlf` by hand or with a
  small Node script (repo rule: Node, no Python).
- IDs [S20]: generated from text + meaning. "If you change either the text or the meaning, then the
  `id` attribute changes." With generated IDs, an edited English string becomes a missing Spanish
  translation (caught by `i18nMissingTranslation: "error"`). Custom IDs (`@@id`) keep IDs stable but
  let stale Spanish survive silently. Generated IDs + the error setting is the safer default.
- Format trade-off: XLIFF (1.2 or 2) keeps `meaning|description` notes for the translator; Angular's
  `json` format is a flat id -> text map that is easier to diff and script but drops the notes.
- Marking text [S21]: `i18n` on elements, `i18n-<attr>` for attributes (`i18n-title`,
  `i18n-aria-label`, `i18n-placeholder`), `` $localize`:meaning|description@@id:text` `` in TS,
  metadata `{meaning}|{description}@@{custom_id}`.
- ICU [S21]: `{count, plural, =0 {...} =1 {...} other {{{ count }} ...}}` and
  `{x, select, a {...} other {...}}` inside an `i18n` element. Spanish plural categories come from
  CLDR data in `@angular/common/locales/es.js`: `one`, `many` (exact millions / large exponents),
  `other` [S22]. Always provide `other`; it covers `many`.
- Spartan helm components in `src/app/ui` contain their own English strings (e.g. sr-only labels);
  those need `i18n` marks too or are passed in from features. Files are CLI-generated, so changes
  there must survive regeneration.

## 7. `npm run verify` and unit tests

Steps today: format, typecheck-electron, typecheck-app, typecheck-spec, lint, test-renderer,
test-electron. None of them builds the app.

- Unit tests: the vitest runner of `@angular/build:unit-test` forces `localize: false` and, if
  `@angular/localize` resolves, prepends `import '@angular/localize/init';` to the TestBed init file
  [S11]. Specs see English source text. Nothing to change.
- Typecheck: covered by the `types` entries `ng add` writes.
- Missing/obsolete translations are only detected by `ng build` (inliner diagnostics; `warning` by
  default, `error` with `i18nMissingTranslation: "error"`) [S10]. Options for a gate:
  - an `i18n` verify step: `ng extract-i18n` to a temp dir, then a Node script that diffs unit IDs
    against `src/locale/messages.es.xlf` (missing and obsolete). Fast, no full build.
  - or a `build` step in verify (slower, but also catches budget/template errors).
- Duplicate translations: `i18nDuplicateTranslation` (default `warning`) on build and extract.

## 8. e2e

- Playwright launches the built app (`npm run e2e` builds first), so main's new per-locale path is
  what e2e exercises.
- The locale must be deterministic: the OS language of the machine decides it otherwise. Either seed
  the override file into the temp `userData` the fixture creates, or honor an env var such as
  `SPENCE_LOCALE` only when `SPENCE_E2E=1`. Default the fixture to `en` so existing baselines hold.
- Spanish visual states: add specs that launch with `es` and shoot `<flow>-<state>-es`; one spec that
  switches language from the UI exercises the reload path and the handshake reconnect.
- `page` in the fixture is `app.firstWindow()`; after a language switch the same window navigates, so
  wait for load (`waitForLoadState`) rather than a new window.

## 9. Packaging (electron-builder)

- `files: dist/renderer/**` already includes `en/` and `es/`. No change.
- `electronLanguages` ("The electron locales to keep. By default, all Electron locales used as-is.")
  [S13]. If ever set to shrink the installer, keep `en-US` and `es` (and `es-419` if wanted) so
  Chromium's own UI strings and `app.getLocale()` keep working; `getLocale()` docs say the `locales`
  folder must ship [S12].
- Installer size grows by one extra copy of the renderer JS (roughly the initial bundle size; budget
  is 1.25 MB).

## Summary of changes for the implementation ticket

| Area | Change |
| --- | --- |
| deps | `ng add @angular/localize` (devDependency; polyfill, tsconfig types, triple-slash in `main.ts`) |
| `angular.json` | `i18n` block with `baseHref: ""` per locale; `localize: true`; `i18nMissingTranslation: "error"`; `development` with `localize: false`; `es` build/serve configs; `extract-i18n` target |
| files | `src/locale/messages.xlf` (extracted), `src/locale/messages.es.xlf` (translated) |
| `electron/main.ts` | `rendererIndex(locale)`; locale resolution (override -> `getPreferredSystemLanguages` -> `en`); `loadFile` on switch; dev keeps the dev URL |
| RPC | a Settings/language RPC so the renderer can request the switch (Settings ticket) |
| CSP | none |
| scripts | `dev:es`; `i18n` check script (Node) and a verify step |
| e2e | pin locale in the fixture; Spanish specs/baselines; switch-language spec |
| packaging | none (watch `electronLanguages` if introduced) |

## Sources

- [S1] `node_modules/@angular/build/src/utils/i18n-options.js` (`createI18nOptions`, `loadTranslations`)
- [S2] `node_modules/@angular/build/src/builders/application/i18n.js` (`inlineI18n`)
- [S3] `node_modules/@angular/build/src/builders/application/options.js` (`getLocaleBaseHref`), called directly with node to check the outputs shown
- [S4] `node_modules/@angular/build/src/tools/esbuild/application-code-bundle.js` lines ~492-540 (polyfills, locale insert)
- [S5] `electron/ipc/handshake.ts`, `src/app/core/desktop-port.ts` (this repo)
- [S6] `node_modules/electron/electron.d.ts`, `will-navigate` event docs ("will not emit when the navigation is started programmatically with APIs like `webContents.loadURL`")
- [S7] `node_modules/@angular/build/src/builders/dev-server/vite/index.js` lines 122-127
- [S8] `node_modules/@angular/cli/src/commands/extract-i18n/cli.js` (`findDefaultBuilderName`)
- [S9] `node_modules/@angular/build/src/builders/extract-i18n/schema.json`, `options.js`
- [S10] `node_modules/@angular/build/src/builders/application/schema.json` (`i18nMissingTranslation`, `i18nDuplicateTranslation`)
- [S11] `node_modules/@angular/build/src/builders/unit-test/runners/vitest/build-options.js` (`localize: false`, `hasLocalize`)
- [S12] https://www.electronjs.org/docs/latest/api/app (`getLocale`, `getSystemLocale`, `getPreferredSystemLanguages`) and `electron.d.ts`
- [S13] `node_modules/app-builder-lib/scheme.json` (`electronLanguages`)
- [S14] `@angular/localize@22.2.5` `schematics/ng-add/ng_add_bundle.cjs`; https://angular.dev/guide/i18n/add-package
- [S15] https://angular.dev/guide/i18n/merge
- [S16] `node_modules/@angular/build/src/tools/i18n/i18n-inliner-worker.js` (`inlineLocalize`, `loadLocaleData`, `___NG_LOCALE_INSERT___`)
- [S17] https://angular.dev/guide/i18n/locale-id
- [S18] https://www.electronjs.org/docs/latest/api/command-line-switches (`--lang`, append before `ready`)
- [S19] `node_modules/@angular/build/src/utils/index-file/augment-index-html.js`
- [S20] https://angular.dev/guide/i18n/translation-files
- [S21] https://angular.dev/guide/i18n/prepare
- [S22] `node_modules/@angular/common/locales/es.js` (plural function)
