const REDACTED_HEADER = '[REDACTED]';
const REDACTED_URL_VALUE = 'REDACTED';

const SENSITIVE_EXACT_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

const SENSITIVE_SUBSTRINGS = ['token', 'secret', 'key', 'auth', 'password', 'credential'];

const SENSITIVE_QUERY_PATTERN =
  /(?:token|secret|key|auth|password|passwd|pwd|credential|jwt|bearer|signature|sig|session[-_]?id|session[-_]?token)/i;

/** Whether an HTTP header name may carry secrets or credentials. */
export const isSensitiveHeader = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  if (SENSITIVE_EXACT_HEADERS.has(normalized)) return true;
  return SENSITIVE_SUBSTRINGS.some((part) => normalized.includes(part));
};

/** Whether a URL query parameter name looks like a credential, token, or secret. */
export const isSensitiveQueryParam = (name: string): boolean => SENSITIVE_QUERY_PATTERN.test(name);

/** Redacts sensitive HTTP header values while preserving header names and safe header values. */
export const redactHeaders = (
  headers: Readonly<Record<string, string | ReadonlyArray<string>>>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isSensitiveHeader(name)) {
      out[name] = REDACTED_HEADER;
    } else {
      out[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return out;
};

/** Redacts embedded URL userinfo (`username:password@`) and secret-named query parameters. */
export const redactUrl = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username !== '') parsed.username = REDACTED_URL_VALUE;
    if (parsed.password !== '') parsed.password = REDACTED_URL_VALUE;
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveQueryParam(key)) {
        parsed.searchParams.set(key, REDACTED_URL_VALUE);
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl
      .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]+)@/, `$1${REDACTED_URL_VALUE}@`)
      .replace(/([?&])([^=&#]+)=([^&#]*)/g, (full, sep: string, name: string) =>
        isSensitiveQueryParam(name) ? `${sep}${name}=${REDACTED_URL_VALUE}` : full,
      );
  }
};

export interface NetworkLogEntryInput {
  readonly id: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly error?: string;
  readonly fromCache?: boolean;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly at: number;
}

export interface RedactedNetworkEntry {
  readonly id: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly error?: string;
  readonly fromCache?: boolean;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly at: number;
}

/** Redacts URL credentials, secret query params, and sensitive request/response headers on a network log entry. */
export const redactNetworkEntry = (entry: NetworkLogEntryInput): RedactedNetworkEntry => ({
  id: entry.id,
  method: entry.method,
  url: redactUrl(entry.url),
  resourceType: entry.resourceType,
  ...(entry.status === undefined ? {} : { status: entry.status }),
  ...(entry.statusText === undefined ? {} : { statusText: entry.statusText }),
  ...(entry.error === undefined ? {} : { error: entry.error }),
  ...(entry.fromCache === undefined ? {} : { fromCache: entry.fromCache }),
  ...(entry.requestHeaders === undefined
    ? {}
    : { requestHeaders: redactHeaders(entry.requestHeaders) }),
  ...(entry.responseHeaders === undefined
    ? {}
    : { responseHeaders: redactHeaders(entry.responseHeaders) }),
  at: entry.at,
});
