import { Schema } from 'effect';

export const ObservationId = Schema.String.pipe(Schema.brand('ObservationId')).annotate({
  identifier: 'ObservationId',
});
export type ObservationId = typeof ObservationId.Type;
