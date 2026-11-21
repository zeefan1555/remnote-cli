import { z } from 'zod';
import { SdkCallSchema } from '../../schemas/remnote-schemas.js';

export const REMOTE_ACTION_NAMES = {
  getStatus: 'get_status',
  getSdkCapabilities: 'get_sdk_capabilities',
  sdkCall: 'sdk_call',
} as const;

export type RemoteActionName = (typeof REMOTE_ACTION_NAMES)[keyof typeof REMOTE_ACTION_NAMES];

interface RemoteActionTransport {
  sendFrame(
    action: RemoteActionName,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown>;
}

interface RemoteActionDefinition {
  payload: z.ZodType<Record<string, unknown>>;
  effect: 'read' | 'capability' | 'sdk';
  invoke(
    transport: RemoteActionTransport,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown>;
}

const emptyPayload = z.object({}).strict();
export const REMOTE_ACTION_DEFINITIONS = {
  [REMOTE_ACTION_NAMES.getStatus]: {
    payload: emptyPayload,
    effect: 'read',
    invoke: (transport, payload, timeoutMs) =>
      transport.sendFrame(REMOTE_ACTION_NAMES.getStatus, payload, timeoutMs),
  },
  [REMOTE_ACTION_NAMES.getSdkCapabilities]: {
    payload: emptyPayload,
    effect: 'capability',
    invoke: (transport, payload, timeoutMs) =>
      transport.sendFrame(REMOTE_ACTION_NAMES.getSdkCapabilities, payload, timeoutMs),
  },
  [REMOTE_ACTION_NAMES.sdkCall]: {
    payload: SdkCallSchema,
    effect: 'sdk',
    invoke: (transport, payload, timeoutMs) =>
      transport.sendFrame(REMOTE_ACTION_NAMES.sdkCall, payload, timeoutMs),
  },
} satisfies Record<RemoteActionName, RemoteActionDefinition>;

export async function dispatchRemoteAction(
  transport: RemoteActionTransport,
  action: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  if (!Object.hasOwn(REMOTE_ACTION_DEFINITIONS, action))
    throw new Error(`Unknown Bridge action: ${action}`);
  const definition = REMOTE_ACTION_DEFINITIONS[action as RemoteActionName];
  return await definition.invoke(transport, definition.payload.parse(payload), timeoutMs);
}
