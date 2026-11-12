import { Effect, Schema } from 'effect';

/** `Missing`: the path is not there (`ENOENT`, or `ENOTDIR` when a parent is a file). */
export class FsError extends Schema.TaggedError<FsError>()('FsError', {
  reason: Schema.Literals(['Missing']),
  detail: Schema.String,
}) {}

const isMissing = (error: unknown): boolean => {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * One Node fs call on `path`. A missing path fails `FsError`, the one failure callers act on; any other failure is a
 * defect.
 */
export const tryFs = <A>(path: string, evaluate: () => Promise<A>): Effect.Effect<A, FsError> =>
  Effect.tryPromise(evaluate).pipe(
    Effect.catch(({ cause }) =>
      isMissing(cause)
        ? Effect.fail(new FsError({ reason: 'Missing', detail: path }))
        : Effect.die(cause),
    ),
  );
