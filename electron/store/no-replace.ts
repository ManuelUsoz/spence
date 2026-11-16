import { Effect } from 'effect';
import { link } from 'node:fs/promises';

/** Outcome of a no-replace publication attempt. */
export type PublishResult = 'Published' | 'Exists';

const isEexist = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'EEXIST';

/**
 * Publishes a hard link without replacing an existing target. Source and target
 * refer to the same inode, so writes through either name or an open handle change
 * both. Callers must control and close writable handles and trust the directories
 * and that source is a regular file.
 *
 * Exists only means the target already exists; it does not verify its contents.
 * Unsupported hard links, cross-device links, and other errors propagate as
 * defects (the original error is preserved). This operation provides no
 * durability guarantee.
 */
export const publishNoReplace = (source: string, target: string): Effect.Effect<PublishResult> =>
  Effect.tryPromise({
    try: () => link(source, target),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((): PublishResult => 'Published'),
    Effect.catch((cause) =>
      isEexist(cause) ? Effect.succeed<PublishResult>('Exists') : Effect.die(cause),
    ),
  );
