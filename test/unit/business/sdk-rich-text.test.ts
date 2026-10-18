import { describe, expect, it, vi } from 'vitest';
import { sdkSafeRichText } from '../../../src/business/sdk-rich-text.js';
import { plainText } from '../../../src/business/plain-text.js';

// Shape RemNote stores after rendering an image (2026-10-18, Rem H8OvJ0i5DZGrglEAd).
const rendered = {
  i: 'i',
  url: '%LOCAL_FILE%abc.jpeg',
  width: 732,
  height: 976,
  percent: 0,
};

/** Mirrors the SDK argument validator: percent must be one of the declared values. */
function strictToString(text: unknown[]): Promise<string> {
  for (const el of text)
    if (
      el &&
      typeof el === 'object' &&
      'percent' in el &&
      ![5, 25, 50, 100].includes((el as { percent: number }).percent)
    )
      return Promise.reject(new Error('richText parameter: Invalid input'));
  return Promise.resolve(text.map((el) => (typeof el === 'string' ? el : '[image]')).join(''));
}

describe('sdkSafeRichText', () => {
  it('drops an out-of-enum percent but keeps valid size fields', () => {
    expect(sdkSafeRichText([rendered as never, 'tail'])).toEqual([
      { i: 'i', url: '%LOCAL_FILE%abc.jpeg', width: 732, height: 976 },
      'tail',
    ]);
  });

  it('keeps an allowed percent and leaves the input untouched', () => {
    const input = [{ ...rendered, percent: 50 }];
    expect(sdkSafeRichText(input as never)).toEqual(input);
    const raw = [rendered];
    sdkSafeRichText(raw as never);
    expect(raw[0].percent).toBe(0);
  });

  it('applies the audio enum, drops non-numeric sizes and recurses into labels', () => {
    expect(
      sdkSafeRichText([
        { i: 'a', url: 'x.mp3', percent: 5 },
        { i: 'i', url: 'y.png', width: '732', label: [{ i: 'i', url: 'z.png', percent: 0 }] },
      ] as never)
    ).toEqual([
      { i: 'a', url: 'x.mp3' },
      { i: 'i', url: 'y.png', label: [{ i: 'i', url: 'z.png' }] },
    ]);
  });

  it('treats undefined as empty rich text', () => {
    expect(sdkSafeRichText(undefined)).toEqual([]);
  });
});

describe('plainText with a rendered image', () => {
  it('renders instead of failing SDK validation', async () => {
    const plugin = { richText: { toString: vi.fn(strictToString) } };
    await expect(plainText(plugin as never, [rendered] as never)).resolves.toBe('[image]');
    expect(plugin.richText.toString).toHaveBeenCalledWith([
      { i: 'i', url: '%LOCAL_FILE%abc.jpeg', width: 732, height: 976 },
    ]);
  });
});
