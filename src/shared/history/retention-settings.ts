import { Schema } from 'effect';

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveBytes = Schema.Int.check(Schema.isGreaterThan(0));

/** Limits and capture windows for the History Store, in bytes and milliseconds. */
export const HistoryRetentionSettings = Schema.Struct({
  perFileBytes: PositiveBytes,
  checkpointBytes: PositiveBytes,
  totalBytes: PositiveBytes,
  beforeMs: PositiveFinite,
  afterMs: PositiveFinite,
  cleanupEnabled: Schema.Boolean,
  maxAgeMs: Schema.NullOr(PositiveFinite),
}).annotate({ identifier: 'HistoryRetentionSettings' });
export type HistoryRetentionSettings = typeof HistoryRetentionSettings.Type;

export const DEFAULT_HISTORY_RETENTION_SETTINGS: HistoryRetentionSettings = {
  perFileBytes: 50 * 1024 ** 2,
  checkpointBytes: 500 * 1024 ** 2,
  totalBytes: 5 * 1024 ** 3,
  beforeMs: 2_000,
  afterMs: 5_000,
  cleanupEnabled: true,
  maxAgeMs: null,
};

/** Recover each valid persisted field independently when settings evolve. */
export function decodeHistoryRetentionSettings(input: unknown): HistoryRetentionSettings {
  const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
  const read = <K extends keyof HistoryRetentionSettings>(key: K): HistoryRetentionSettings[K] => {
    const value = Reflect.get(fields, key);
    const schema = HistoryRetentionSettings.fields[key];
    return Schema.is(schema)(value) ? value : DEFAULT_HISTORY_RETENTION_SETTINGS[key];
  };
  return {
    perFileBytes: read('perFileBytes'),
    checkpointBytes: read('checkpointBytes'),
    totalBytes: read('totalBytes'),
    beforeMs: read('beforeMs'),
    afterMs: read('afterMs'),
    cleanupEnabled: read('cleanupEnabled'),
    maxAgeMs: read('maxAgeMs'),
  };
}
