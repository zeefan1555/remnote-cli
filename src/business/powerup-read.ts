import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import { PowerupSlotCodeMap } from './sdk-constants.generated.js';

const SLOT_CODES = PowerupSlotCodeMap as unknown as Record<string, Record<string, string>>;

/**
 * SDK 0.0.46 looks up a built-in slot by name (`Filter`) and drops a raw code (`f`).
 * A known code becomes that name. A name, a custom powerup, or an unknown code is unchanged.
 */
export function builtinSlotName(powerup: string, slot: string): string {
  const slots = Object.hasOwn(SLOT_CODES, powerup) ? SLOT_CODES[powerup] : undefined;
  if (!slots || Object.hasOwn(slots, slot)) return slot;
  const names = Object.entries(slots)
    .filter(([, code]) => code === slot)
    .map(([name]) => name);
  return names.length === 1 ? names[0] : slot;
}

export type PowerupReadAs = 'value' | 'richtext' | 'rem';

export interface PowerupGetParams {
  remId: string;
  powerup: string;
  slot: string;
  as?: PowerupReadAs;
}

export interface PowerupGetResult {
  remId: string;
  powerup: string;
  slot: string;
  as: PowerupReadAs;
  value: unknown;
}

/**
 * Read one powerup slot. The CLI translates a known built-in slot code to its SDK name,
 * then calls the public Rem method. Unknown codes are passed through so the host error surfaces.
 * `getPowerupByCode` is not used: the host can return undefined for a built-in powerup Rem.
 */
export async function getPowerupSlot(
  plugin: ReactRNPlugin,
  params: PowerupGetParams
): Promise<PowerupGetResult> {
  const as = params.as ?? 'value';
  const rem = await plugin.rem.findOne(params.remId);
  if (!rem || rem._id !== params.remId) throw new Error(`Rem not found: ${params.remId}`);
  const slot = builtinSlotName(params.powerup, params.slot);
  const value =
    as === 'richtext'
      ? await rem.getPowerupPropertyAsRichText(params.powerup, slot)
      : as === 'rem'
        ? await rem.getPowerupPropertyAsRem(params.powerup, slot)
        : await rem.getPowerupProperty(params.powerup, slot);
  return {
    remId: params.remId,
    powerup: params.powerup,
    slot: params.slot,
    as,
    value: value ?? null,
  };
}
