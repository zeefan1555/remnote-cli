import type { RichTextInterface } from '@remnote/plugin-sdk';

/**
 * RemNote itself can store media sizes the SDK argument validator rejects. After an image is
 * rendered it gains width/height/percent, and percent can be 0, which is outside the declared
 * SDK enum. richText.toString / toMarkdown then fail with "richText parameter: Invalid input".
 * Size fields never change rendered text, so only invalid ones are dropped from a copy passed
 * to the SDK renderer. The stored Rem is not modified.
 */
const PERCENT: Record<string, ReadonlySet<number>> = {
  i: new Set([5, 25, 50, 100]),
  a: new Set([25, 50, 100]),
};

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = clean(entry);
  const allowed = typeof out.i === 'string' ? PERCENT[out.i] : undefined;
  if (allowed) {
    if (out.percent !== undefined && !allowed.has(out.percent as number)) delete out.percent;
    for (const key of ['width', 'height'])
      if (
        out[key] !== undefined &&
        (typeof out[key] !== 'number' || !Number.isFinite(out[key] as number))
      )
        delete out[key];
  }
  return out;
}

export function sdkSafeRichText(text: RichTextInterface | undefined): RichTextInterface {
  return clean(text ?? []) as RichTextInterface;
}
