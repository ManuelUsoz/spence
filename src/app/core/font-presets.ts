import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Effect, Exit } from 'effect';
import type { FontPreset } from '../../shared/settings/settings.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

const EMOJI = "'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";
const SANS_FALLBACK = `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif, ${EMOJI}`;
const MONO_FALLBACK = "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace";
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";

/** One Font preset: the three families of the typography roles, and how the voice (Titles) is set. */
export interface FontPresetDefinition {
  readonly id: FontPreset;
  readonly label: string;
  /** Short line under the label: which fonts the preset is made of. */
  readonly summary: string;
  /** `font-sans`: everything people read or click. */
  readonly sans: string;
  /** `font-mono`: what the machine reads or the user would copy. */
  readonly mono: string;
  /** `font-display`: the voice, used rarely at `text-xl` or larger. */
  readonly display: string;
  /** Letter-spacing of the voice: a serif needs less pulling in than a sans. */
  readonly displayTracking: string;
}

const goeistSans = `'Goeist', ${SANS_FALLBACK}`;
const goeistMono = `'Goeist Mono', ${MONO_FALLBACK}`;
const inter = `'Inter Variable', ${SANS_FALLBACK}`;
const geist = `'Geist Variable', ${SANS_FALLBACK}`;
const geistMono = `'Geist Mono Variable', ${MONO_FALLBACK}`;
const jetbrainsMono = `'JetBrains Mono Variable', ${MONO_FALLBACK}`;
const plexSans = `'IBM Plex Sans', ${SANS_FALLBACK}`;
const plexMono = `'IBM Plex Mono', ${MONO_FALLBACK}`;

/** The presets in the order Settings lists them. Goeist is first and the default. */
export const FONT_PRESETS: ReadonlyArray<FontPresetDefinition> = [
  {
    id: 'goeist',
    label: 'Goeist',
    summary: 'Goeist · Goeist · Goeist Mono',
    sans: goeistSans,
    mono: goeistMono,
    display: goeistSans,
    displayTracking: '-0.03em',
  },
  {
    id: 'inter',
    label: 'Inter',
    summary: 'Inter · Inter · JetBrains Mono',
    sans: inter,
    mono: jetbrainsMono,
    display: inter,
    displayTracking: '-0.03em',
  },
  {
    id: 'editorial',
    label: 'Editorial',
    summary: 'Instrument Serif · Inter · Geist Mono',
    sans: inter,
    mono: geistMono,
    display: `'Instrument Serif', ${SERIF_FALLBACK}`,
    displayTracking: '-0.01em',
  },
  {
    id: 'plex',
    label: 'Plex',
    summary: 'IBM Plex Serif · IBM Plex Sans · IBM Plex Mono',
    sans: plexSans,
    mono: plexMono,
    display: `'IBM Plex Serif', ${SERIF_FALLBACK}`,
    displayTracking: '-0.01em',
  },
  {
    id: 'literary',
    label: 'Literary',
    summary: 'Newsreader · Inter · JetBrains Mono',
    sans: inter,
    mono: jetbrainsMono,
    display: `'Newsreader Variable', ${SERIF_FALLBACK}`,
    displayTracking: '-0.015em',
  },
  {
    id: 'soft-serif',
    label: 'Soft serif',
    summary: 'Fraunces · Geist · Geist Mono',
    sans: geist,
    mono: geistMono,
    display: `'Fraunces Variable', ${SERIF_FALLBACK}`,
    displayTracking: '-0.02em',
  },
];

export const DEFAULT_FONT_PRESET: FontPreset = 'goeist';

export const fontPresetOf = (id: FontPreset | undefined): FontPresetDefinition =>
  FONT_PRESETS.find((preset) => preset.id === (id ?? DEFAULT_FONT_PRESET)) ??
  // `FONT_PRESETS` always starts with the default, so the fallback is never undefined at runtime.
  (FONT_PRESETS[0] as FontPresetDefinition);

/** The CSS variables a preset sets: the tokens `font-sans`, `font-mono` and `font-display` read. */
export const fontVars = (id: FontPreset | undefined): Readonly<Record<string, string>> => {
  const preset = fontPresetOf(id);
  return {
    '--font-sans': preset.sans,
    '--font-mono': preset.mono,
    '--font-display': preset.display,
    '--font-display-tracking': preset.displayTracking,
  };
};

const getSettings = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Settings.get']();
});

/**
 * The Font preset in force. Reads `Settings.get` once at startup, then follows `SettingsStore` commits; applying a
 * preset sets the font variables on the document root, so every Tailwind font utility changes with no reload.
 */
@Injectable({ providedIn: 'root' })
export class FontPresets {
  private readonly runtime = inject(EffectRuntime);
  private readonly root = inject(DOCUMENT).documentElement;
  private readonly aborts = new AbortController();
  private readonly _active = signal<FontPreset>(DEFAULT_FONT_PRESET);

  readonly active = this._active.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(getSettings(), { signal: this.aborts.signal }).then((exit) => {
      if (Exit.isSuccess(exit)) this.apply(exit.value.fontPreset);
    });
  }

  /** Makes `id` the active preset (`undefined`: the default). */
  apply(id: FontPreset | undefined): void {
    const next = fontPresetOf(id).id;
    this._active.set(next);
    for (const [name, value] of Object.entries(fontVars(next))) {
      this.root.style.setProperty(name, value);
    }
  }
}
