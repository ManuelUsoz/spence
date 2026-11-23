import { Effect, Schema, Semaphore } from 'effect';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { MessageSender, SessionId } from '../../src/shared/sessions/sessions.rpc';
import { Store, type VersionedFile } from '../store/store';

const Exchange = Schema.Struct({
  id: Schema.String,
  fingerprint: Schema.String,
  sender: MessageSender,
  target: SessionId,
  project: ProjectId,
  projectName: Schema.String,
  title: Schema.String,
  text: Schema.String,
  startsSession: Schema.Boolean,
  tabOpened: Schema.Boolean,
  status: Schema.Literals(['queued', 'started', 'failed']),
  delivery: Schema.optionalKey(Schema.Literals(['queued', 'started'])),
  failure: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Exchange' });

export type Exchange = typeof Exchange.Type;

const State = Schema.Struct({ exchanges: Schema.Array(Exchange) });
const file: VersionedFile<typeof State.Type> = {
  file: 'session-exchanges.json',
  version: 1,
  migrations: [],
  schema: State,
  initial: () => ({ exchanges: [] }),
};

export const makeCoordinationStore = Effect.gen(function* () {
  const store = yield* Store;
  const lock = yield* Semaphore.make(1);
  const load = yield* Effect.cached(store.readVersioned(file).pipe(Effect.orDie));
  let current: ReadonlyArray<Exchange> | undefined;
  const list = Effect.suspend(() =>
    current === undefined
      ? Effect.map(load, (state) => current ?? state.exchanges)
      : Effect.succeed(current),
  );
  const update = (change: (entries: ReadonlyArray<Exchange>) => ReadonlyArray<Exchange>) =>
    lock.withPermit(
      Effect.gen(function* () {
        const before = yield* list;
        const exchanges = change(before);
        if (before === exchanges) return;
        yield* store.writeVersioned(file, { exchanges });
        current = exchanges;
      }).pipe(Effect.uninterruptible),
    );
  return { list, update };
});

export type CoordinationStore = Effect.Success<typeof makeCoordinationStore>;
