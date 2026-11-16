import { RequestError } from '@agentclientprotocol/sdk/unstable';
import { Effect, Schema } from 'effect';

/** JSON-RPC error code ACP uses for "authentication required". */
const AUTH_REQUIRED = -32000;

/**
 * Why talking to an Agent over ACP did not work.
 *
 * - `ProtocolVersion`: the Agent answered `initialize` with a protocol version other than 1.
 * - `AuthRequired`: the Agent needs the user to log in first.
 * - `Unsupported`: the Agent does not advertise the capability the call needs.
 * - `Exited`: the Agent process is gone (crashed, killed, or closed its stdout).
 * - `Refused`: the Agent answered the request with any other error.
 */
export class AcpError extends Schema.TaggedError<AcpError>()('AcpError', {
  reason: Schema.Literals(['ProtocolVersion', 'AuthRequired', 'Unsupported', 'Exited', 'Refused']),
  detail: Schema.String,
}) {}

const requestErrorDetail = (error: RequestError): string => {
  if (error.message === 'Internal error') {
    if (typeof error.data === 'string' && error.data.length > 0) return error.data;
    if (typeof error.data === 'object' && error.data !== null) {
      if ('details' in error.data && typeof error.data.details === 'string') {
        return error.data.details;
      }
      if ('message' in error.data && typeof error.data.message === 'string') {
        return error.data.message;
      }
    }
  }
  return error.message;
};

/**
 * Maps what an SDK call rejected with to an `AcpError`. A JSON-RPC error is the Agent's answer; anything else means
 * the connection closed under the call.
 */
export const fromRejection = (method: string, error: unknown): AcpError => {
  if (error instanceof RequestError) {
    return new AcpError({
      reason: error.code === AUTH_REQUIRED ? 'AuthRequired' : 'Refused',
      detail:
        error.code === AUTH_REQUIRED
          ? `${method}: ${error.message} (${error.code})`
          : requestErrorDetail(error),
    });
  }
  return new AcpError({
    reason: 'Exited',
    detail: `${method}: ${error instanceof Error ? error.message : String(error)}`,
  });
};

/** An SDK request as an effect: aborted when interrupted, rejections mapped to `AcpError`. */
export const acpRequest = <A>(
  method: string,
  request: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, AcpError> =>
  Effect.tryPromise({ try: request, catch: (error) => fromRejection(method, error) });

/** Fails with `Unsupported` unless the Agent advertised what `method` needs. */
export const requireCapability = (
  advertised: boolean,
  method: string,
): Effect.Effect<void, AcpError> =>
  advertised
    ? Effect.void
    : Effect.fail(
        new AcpError({ reason: 'Unsupported', detail: `The Agent does not offer ${method}` }),
      );
