/** Longest URL accepted across the Browser policy boundary. */
const MAX_BROWSER_URL_LENGTH = 8_192;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LOOPBACK_PREFIX = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#].*)?$/i;
const HOST_WITH_PORT = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+:\d+(?:[/?#].*)?$/;
const EXPLICIT_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export type UserUrlParseResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason: 'InvalidUrl' | 'SchemeBlocked';
      readonly detail: string;
    };

export type AgentUrlClassification =
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'loopback'; readonly origin: string; readonly url: string }
  | { readonly kind: 'external'; readonly origin: string; readonly url: string };

const tryParseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const hasValidControlAndLength = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_BROWSER_URL_LENGTH && !CONTROL_CHARS.test(value);

/**
 * Parses and normalizes a user-entered address-bar URL, returning a typed failure reason when invalid or blocked.
 */
export const parseUserUrl = (input: string): UserUrlParseResult => {
  if (CONTROL_CHARS.test(input)) {
    return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
  }
  const trimmed = input.trim();
  if (!hasValidControlAndLength(trimmed) || /\s/.test(trimmed)) {
    return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
  }
  if (/^about:blank$/i.test(trimmed)) {
    return { ok: true, url: 'about:blank' };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = tryParseUrl(trimmed);
    if (parsed === null || parsed.hostname === '') {
      return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
    }
    return { ok: true, url: parsed.href };
  }
  if (LOOPBACK_PREFIX.test(trimmed)) {
    const parsed = tryParseUrl(`http://${trimmed}`);
    if (parsed === null || parsed.hostname === '') {
      return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
    }
    return { ok: true, url: parsed.href };
  }
  const schemeMatch = EXPLICIT_SCHEME.exec(trimmed);
  if (schemeMatch !== null) {
    if (HOST_WITH_PORT.test(trimmed)) {
      const parsed = tryParseUrl(`https://${trimmed}`);
      if (parsed !== null && parsed.hostname !== '') {
        return { ok: true, url: parsed.href };
      }
      return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
    }
    const scheme = schemeMatch[1]?.toLowerCase() ?? 'unknown';
    return {
      ok: false,
      reason: 'SchemeBlocked',
      detail: `Blocked unsupported URL scheme "${scheme}:".`,
    };
  }
  if (/^[/?#.]/.test(trimmed)) {
    return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
  }
  const parsed = tryParseUrl(`https://${trimmed}`);
  if (
    parsed === null ||
    parsed.hostname === '' ||
    parsed.hostname.startsWith('.') ||
    parsed.hostname.endsWith('.') ||
    parsed.hostname.includes('..') ||
    !parsed.hostname.includes('.')
  ) {
    return { ok: false, reason: 'InvalidUrl', detail: 'Enter a valid web address.' };
  }
  return { ok: true, url: parsed.href };
};

/**
 * Normalizes a user-typed address-bar URL (`localhost`/`127.0.0.1`/`[::1]` -> `http://`, bare hosts -> `https://`,
 * allows `http:`, `https:`, `about:blank`), returning `null` when invalid or scheme-blocked.
 */
export const normalizeUserUrl = (input: string): string | null => {
  const result = parseUserUrl(input);
  return result.ok ? result.url : null;
};

/** Whether a popup URL may open as a new Page inside the embedded Browser (`http:` or `https:` only). */
export const isAllowedPopupUrl = (url: string): boolean => {
  if (!hasValidControlAndLength(url) || url.trim() !== url) return false;
  const parsed = tryParseUrl(url);
  if (parsed === null || parsed.hostname === '') return false;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
};

/** Whether a Browser Page URL may be handed off to the OS default browser (`http:` / `https:`, no credentials). */
export const isAllowedExternalBrowserUrl = (url: string): boolean => {
  if (!hasValidControlAndLength(url) || url.trim() !== url) return false;
  const parsed = tryParseUrl(url);
  if (parsed === null || parsed.hostname === '') return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.username === '' && parsed.password === '';
};

const isLoopbackHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === '127.0.0.1' ||
    lower === '[::1]' ||
    lower === '::1'
  );
};

/** Classifies an Agent-requested URL into `'blocked'`, `'loopback'`, or `'external'`. */
export const classifyAgentUrl = (url: string): AgentUrlClassification => {
  if (!hasValidControlAndLength(url) || url.trim() !== url) {
    return { kind: 'blocked', reason: 'Invalid or empty URL.' };
  }
  const parsed = tryParseUrl(url);
  if (parsed === null || parsed.hostname === '') {
    return { kind: 'blocked', reason: 'Malformed URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'blocked', reason: `Scheme "${parsed.protocol}" is not permitted.` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { kind: 'blocked', reason: 'Credentials in URLs are not permitted.' };
  }
  if (isLoopbackHost(parsed.hostname)) {
    return { kind: 'loopback', origin: parsed.origin, url: parsed.href };
  }
  return { kind: 'external', origin: parsed.origin, url: parsed.href };
};

/** Whether `deviceId` identifies a Paired remote Device (`undefined` and `'local'` are local). */
export const isRemoteDevice = (deviceId?: string): boolean =>
  deviceId !== undefined && deviceId !== 'local';
