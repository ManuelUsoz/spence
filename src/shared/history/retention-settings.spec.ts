import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HISTORY_RETENTION_SETTINGS, HistoryRetentionSettings } from './retention-settings';

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
    for (const key of ['perFileBytes', 'checkpointBytes', 'totalBytes', 'beforeMs', 'afterMs', 'maxAgeMs']) {
      for (const value of [0, -1, Infinity, -Infinity, NaN]) {
        expect(() => decode({ ...DEFAULT_HISTORY_RETENTION_SETTINGS, [key]: value })).toThrow();
      }
    }
    expect(decode({ ...DEFAULT_HISTORY_RETENTION_SETTINGS, maxAgeMs: 1 }).maxAgeMs).toBe(1);
  });
});
