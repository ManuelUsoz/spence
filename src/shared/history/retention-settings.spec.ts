import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  decodeHistoryRetentionSettings,
  DEFAULT_HISTORY_RETENTION_SETTINGS,
  HistoryRetentionSettings,
} from './retention-settings';

const decode = Schema.decodeUnknownSync(HistoryRetentionSettings);

describe('HistoryRetentionSettings', () => {
  it('accepts the documented defaults', () => {
    expect(decode(DEFAULT_HISTORY_RETENTION_SETTINGS)).toEqual({
      perFileBytes: 50 * 1024 ** 2,
      checkpointBytes: 500 * 1024 ** 2,
      totalBytes: 5 * 1024 ** 3,
      beforeMs: 2000,
      afterMs: 5000,
      cleanupEnabled: true,
      maxAgeMs: null,
    });
  });

  it('rejects non-positive and non-finite numeric values', () => {
    for (const key of [
      'perFileBytes',
      'checkpointBytes',
      'totalBytes',
      'beforeMs',
      'afterMs',
      'maxAgeMs',
    ]) {
      for (const value of [0, -1, Infinity, -Infinity, NaN]) {
        expect(() => decode({ ...DEFAULT_HISTORY_RETENTION_SETTINGS, [key]: value })).toThrow();
      }
    }
    expect(decode({ ...DEFAULT_HISTORY_RETENTION_SETTINGS, maxAgeMs: 1 }).maxAgeMs).toBe(1);
  });

  it('rejects fractional byte budgets while allowing fractional durations', () => {
    for (const key of ['perFileBytes', 'checkpointBytes', 'totalBytes']) {
      expect(() => decode({ ...DEFAULT_HISTORY_RETENTION_SETTINGS, [key]: 1.5 })).toThrow();
    }
    expect(
      decode({ ...DEFAULT_HISTORY_RETENTION_SETTINGS, beforeMs: 1.5, afterMs: 2.5, maxAgeMs: 3.5 }),
    ).toMatchObject({
      beforeMs: 1.5,
      afterMs: 2.5,
      maxAgeMs: 3.5,
    });
  });
});

describe('decodeHistoryRetentionSettings', () => {
  it('defaults missing and malformed inputs', () => {
    for (const input of [
      undefined,
      null,
      [],
      'settings',
      {},
      { beforeMs: -1, cleanupEnabled: 'true' },
    ]) {
      expect(decodeHistoryRetentionSettings(input)).toEqual(DEFAULT_HISTORY_RETENTION_SETTINGS);
    }
  });

  it('retains valid fields independently and preserves null age', () => {
    expect(
      decodeHistoryRetentionSettings({
        perFileBytes: 12,
        checkpointBytes: 1.5,
        beforeMs: 2.5,
        cleanupEnabled: false,
        maxAgeMs: null,
      }),
    ).toEqual({
      ...DEFAULT_HISTORY_RETENTION_SETTINGS,
      perFileBytes: 12,
      beforeMs: 2.5,
      cleanupEnabled: false,
      maxAgeMs: null,
    });
    const valid = {
      perFileBytes: 1,
      checkpointBytes: 2,
      totalBytes: 3,
      beforeMs: 4,
      afterMs: 5,
      cleanupEnabled: false,
      maxAgeMs: 6,
    };
    expect(decodeHistoryRetentionSettings(valid)).toEqual(valid);
  });
});
