import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
  classifyAgentUrl,
  isAllowedExternalBrowserUrl,
  isAllowedPopupUrl,
  isRemoteDevice,
  normalizeUserUrl,
} from './url-policy';
import { BrowserError, BrowserState, PageId } from './browser.rpc';
import { SessionId } from '../sessions/sessions.rpc';

describe('browser url-policy', () => {
  describe('normalizeUserUrl', () => {
    it('trims and preserves explicit http, https, and about:blank URLs', () => {
      expect(normalizeUserUrl('  https://example.com/docs?q=1#top  ')).toBe(
        'https://example.com/docs?q=1#top',
      );
      expect(normalizeUserUrl('http://127.0.0.1:4200/app')).toBe('http://127.0.0.1:4200/app');
      expect(normalizeUserUrl('about:blank')).toBe('about:blank');
      expect(normalizeUserUrl('  ABOUT:BLANK  ')).toBe('about:blank');
    });

    it('normalizes loopback hosts without scheme to http://', () => {
      expect(normalizeUserUrl('localhost')).toBe('http://localhost/');
      expect(normalizeUserUrl('localhost:3000/api')).toBe('http://localhost:3000/api');
      expect(normalizeUserUrl('127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health');
      expect(normalizeUserUrl('[::1]:5173/home')).toBe('http://[::1]:5173/home');
      expect(normalizeUserUrl('[::1]')).toBe('http://[::1]/');
    });

    it('normalizes bare hostnames to https://', () => {
      expect(normalizeUserUrl('example.com')).toBe('https://example.com/');
      expect(normalizeUserUrl('docs.angular.dev/guide/signals')).toBe(
        'https://docs.angular.dev/guide/signals',
      );
      expect(normalizeUserUrl('app.example.com:8443/login')).toBe(
        'https://app.example.com:8443/login',
      );
    });

    it('rejects blocked schemes, control chars, and invalid URLs', () => {
      for (const bad of [
        '',
        '   ',
        'file:///etc/passwd',
        'chrome://settings',
        'javascript:alert(1)',
        'data:text/html,<h1>hi</h1>',
        'about:config',
        'ftp://files.example.com',
        'not a valid url',
        '/relative/path',
        'https://example.com/\n',
        'http://',
        'localhost:99999',
        'invalid',
      ]) {
        expect(normalizeUserUrl(bad), bad).toBeNull();
      }
    });
  });

  describe('isAllowedPopupUrl', () => {
    it('allows only http and https URLs', () => {
      expect(isAllowedPopupUrl('https://example.com/auth')).toBe(true);
      expect(isAllowedPopupUrl('http://localhost:3000/callback')).toBe(true);
      expect(isAllowedPopupUrl('about:blank')).toBe(false);
      expect(isAllowedPopupUrl('javascript:alert(1)')).toBe(false);
      expect(isAllowedPopupUrl('file:///etc/passwd')).toBe(false);
      expect(isAllowedPopupUrl('data:text/html,hi')).toBe(false);
    });
  });

  describe('isAllowedExternalBrowserUrl', () => {
    it('allows http and https without credentials or outer whitespace/control chars', () => {
      expect(isAllowedExternalBrowserUrl('https://example.com/docs')).toBe(true);
      expect(isAllowedExternalBrowserUrl('http://localhost:3000')).toBe(true);
      expect(isAllowedExternalBrowserUrl('https://user:pass@example.com')).toBe(false);
      expect(isAllowedExternalBrowserUrl(' https://example.com')).toBe(false);
      expect(isAllowedExternalBrowserUrl('https://example.com\t')).toBe(false);
      expect(isAllowedExternalBrowserUrl('about:blank')).toBe(false);
      expect(isAllowedExternalBrowserUrl('file:///etc/passwd')).toBe(false);
      expect(isAllowedExternalBrowserUrl(`https://example.com/${'a'.repeat(8192)}`)).toBe(false);
    });
  });

  describe('classifyAgentUrl', () => {
    it('classifies loopback, external, and blocked URLs cleanly', () => {
      expect(classifyAgentUrl('http://localhost:3000/app')).toEqual({
        kind: 'loopback',
        origin: 'http://localhost:3000',
        url: 'http://localhost:3000/app',
      });
      expect(classifyAgentUrl('https://127.0.0.1:8443/test')).toEqual({
        kind: 'loopback',
        origin: 'https://127.0.0.1:8443',
        url: 'https://127.0.0.1:8443/test',
      });
      expect(classifyAgentUrl('http://[::1]:5173')).toEqual({
        kind: 'loopback',
        origin: 'http://[::1]:5173',
        url: 'http://[::1]:5173/',
      });
      expect(classifyAgentUrl('https://example.com/login')).toEqual({
        kind: 'external',
        origin: 'https://example.com',
        url: 'https://example.com/login',
      });
      expect(classifyAgentUrl('file:///etc/passwd').kind).toBe('blocked');
      expect(classifyAgentUrl('about:blank').kind).toBe('blocked');
      expect(classifyAgentUrl('javascript:alert(1)').kind).toBe('blocked');
      expect(classifyAgentUrl('https://user:secret@example.com').kind).toBe('blocked');
      expect(classifyAgentUrl('not-a-url').kind).toBe('blocked');
    });
  });

  describe('isRemoteDevice', () => {
    it('treats undefined and local as local, and any other id as remote', () => {
      expect(isRemoteDevice(undefined)).toBe(false);
      expect(isRemoteDevice('local')).toBe(false);
      expect(isRemoteDevice('peer-1')).toBe(true);
    });
  });
});

describe('browser.rpc schemas', () => {
  it('encodes and decodes BrowserState and BrowserError', () => {
    const state: BrowserState = {
      sessionId: SessionId.make('s1'),
      open: true,
      width: 480,
      pages: [
        {
          id: PageId.make('p1'),
          url: 'https://example.com',
          title: 'Example',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          suspended: false,
        },
      ],
      activePageId: PageId.make('p1'),
      control: { _tag: 'idle' },
      pickerActive: false,
      occluded: false,
    };
    const encoded = Schema.encodeSync(BrowserState)(state);
    expect(Schema.decodeUnknownSync(BrowserState)(encoded)).toEqual(state);

    const err = new BrowserError({ reason: 'SchemeBlocked', detail: 'Blocked scheme' });
    expect(err._tag).toBe('BrowserError');
    expect(err.reason).toBe('SchemeBlocked');
  });
});
