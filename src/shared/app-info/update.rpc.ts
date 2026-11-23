import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

export const UpdateResult = Schema.Struct({
  status: Schema.Literals(['available', 'current', 'unsupported', 'failed']),
  detail: Schema.String,
});
export const UpdateRpcs = RpcGroup.make(
  Rpc.make('Update.check', { success: UpdateResult }),
  Rpc.make('Update.install', { success: Schema.Boolean }),
);
