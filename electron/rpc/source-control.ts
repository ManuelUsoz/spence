import { Effect, Stream } from 'effect';
import { SourceControlRpcs } from '../../src/shared/source-control/source-control.rpc';
import { Operations } from '../source-control/operations';

/** Handler layer for Wave 2 source control RPCs. */
export const layerSourceControlHandlers = SourceControlRpcs.toLayer({
  'SourceControl.listOperations': Effect.fn('SourceControl.listOperations')(function* (filter) {
    const operations = yield* Operations;
    return yield* operations.listOperations(filter);
  }),
  'SourceControl.getOperation': Effect.fn('SourceControl.getOperation')(function* ({
    operationId,
  }) {
    const operations = yield* Operations;
    return yield* operations.getOperation(operationId);
  }),
  'SourceControl.operationEvents': () =>
    Stream.unwrap(Operations.use((operations) => Effect.succeed(operations.updates))),
  'SourceControl.reconcileOperation': Effect.fn('SourceControl.reconcileOperation')(function* ({
    operationId,
  }) {
    const operations = yield* Operations;
    return yield* operations.reconcileOperation(operationId);
  }),
  'SourceControl.dismissOperation': Effect.fn('SourceControl.dismissOperation')(function* ({
    operationId,
  }) {
    const operations = yield* Operations;
    return yield* operations.dismissOperation(operationId);
  }),
  'SourceControl.cancelOperation': Effect.fn('SourceControl.cancelOperation')(function* ({
    operationId,
  }) {
    const operations = yield* Operations;
    return yield* operations.cancelOperation(operationId);
  }),
});
