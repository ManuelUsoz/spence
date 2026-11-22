import { describe, expect, it } from 'vitest';
import { redactHeaders, redactNetworkEntry, redactUrl } from './redaction';

describe('browser redaction', () => {
  it('redacts sensitive headers case-insensitively while preserving safe headers', () => {
    const result = redactHeaders({
      Authorization: 'Bearer super-secret-jwt',
      'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      Cookie: 'session=abc123; theme=dark',
      'Set-Cookie': ['sid=xyz; HttpOnly', 'csrf=secret'],
      'X-API-Key': 'key-12345',
      'X-Auth-User': 'alice',
      'X-Custom-Token': 'tok-999',
      'X-Client-Secret': 'sec-888',
      'X-Password-Hash': 'pw-777',
      'X-Credential-Id': 'cred-666',
      'Content-Type': 'application/json',
      'Cache-Control': ['no-cache', 'no-store'],
    });

    expect(result).toEqual({
      Authorization: '[REDACTED]',
      'Proxy-Authorization': '[REDACTED]',
      Cookie: '[REDACTED]',
      'Set-Cookie': '[REDACTED]',
      'X-API-Key': '[REDACTED]',
      'X-Auth-User': '[REDACTED]',
      'X-Custom-Token': '[REDACTED]',
      'X-Client-Secret': '[REDACTED]',
      'X-Password-Hash': '[REDACTED]',
      'X-Credential-Id': '[REDACTED]',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store',
    });
  });

  it('redacts URL userinfo credentials and secret-named query parameters', () => {
    const redacted = redactUrl(
      'https://alice:s3cr3t@example.com:8443/callback?code=ok&access_token=tok123&apiKey=k9&client_secret=cs1&password=p1&auth=a1&credential=c1&page=2',
    );

    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('s3cr3t');
    expect(redacted).not.toContain('tok123');
    expect(redacted).not.toContain('k9');
    expect(redacted).not.toContain('cs1');
    expect(redacted).not.toContain('p1');
    expect(redacted).not.toContain('a1');
    expect(redacted).not.toContain('c1');

    const parsed = new URL(redacted);
    expect(parsed.username).toBe('REDACTED');
    expect(parsed.password).toBe('REDACTED');
    expect(parsed.searchParams.get('code')).toBe('ok');
    expect(parsed.searchParams.get('page')).toBe('2');
    expect(parsed.searchParams.get('access_token')).toBe('REDACTED');
    expect(parsed.searchParams.get('apiKey')).toBe('REDACTED');
    expect(parsed.searchParams.get('client_secret')).toBe('REDACTED');
    expect(parsed.searchParams.get('password')).toBe('REDACTED');
    expect(parsed.searchParams.get('auth')).toBe('REDACTED');
    expect(parsed.searchParams.get('credential')).toBe('REDACTED');
  });

  it('redacts full network entries before returning them to Agent context', () => {
    const entry = redactNetworkEntry({
      id: 42,
      method: 'POST',
      url: 'https://user:pass@api.example.com/v1/login?token=raw-token&debug=1',
      resourceType: 'xhr',
      status: 200,
      statusText: 'HTTP/1.1 200 OK',
      requestHeaders: {
        Authorization: 'Bearer abc',
        'Content-Type': 'application/json',
      },
      responseHeaders: {
        'Set-Cookie': ['sid=secret'],
        'Content-Type': ['application/json'],
      },
      at: 1000,
    });

    expect(entry.url).not.toContain('user');
    expect(entry.url).not.toContain('pass');
    expect(entry.url).not.toContain('raw-token');
    expect(entry.url).toContain('debug=1');
    expect(entry.requestHeaders).toEqual({
      Authorization: '[REDACTED]',
      'Content-Type': 'application/json',
    });
    expect(entry.responseHeaders).toEqual({
      'Set-Cookie': '[REDACTED]',
      'Content-Type': 'application/json',
    });
  });
});
