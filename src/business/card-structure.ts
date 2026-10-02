import type { RichTextInterface } from '@remnote/plugin-sdk';
export function cardDelimiterIndex(text: RichTextInterface | undefined): number {
  return Array.isArray(text)
    ? text.findIndex((p) => typeof p === 'object' && p !== null && 'i' in p && p.i === 's')
    : -1;
}
export function hasCardStructure(
  text: RichTextInterface | undefined,
  backText: RichTextInterface | undefined,
  cardItem: boolean
): boolean {
  return (
    Boolean(backText?.length) ||
    cardDelimiterIndex(text) >= 0 ||
    cardItem ||
    (Array.isArray(text) &&
      text.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          (('cId' in part && Boolean(part.cId)) ||
            ('blocks' in part && Array.isArray(part.blocks) && part.blocks.length > 0) ||
            ('latexClozes' in part &&
              Array.isArray(part.latexClozes) &&
              part.latexClozes.length > 0))
      ))
  );
}
