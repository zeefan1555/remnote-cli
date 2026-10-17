/**
 * Feature summary of a RemNote rich-text value.
 * Code blocks are rich-text elements with `code: true`. `rem.isCode` is a different flag
 * and is false for a code element nested in text, so it is not consulted here.
 */

export interface RichTextFeatureCounts {
  plain: number;
  code: number;
  cloze: number;
  latex: number;
  image: number;
  rem: number;
  alias: number;
  bold: number;
  italic: number;
  link: number;
  /** Occurrences of the two-character literal `[[` in text, not rem-reference elements. */
  literalBrackets: number;
}

export type RichTextFeature =
  | { kind: 'plain'; text: string }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'cloze'; cId: string }
  | { kind: 'latex'; text: string; cId?: string }
  | { kind: 'image'; url: string }
  | { kind: 'rem'; id: string }
  | { kind: 'alias'; id: string; aliasId: string }
  | { kind: 'bold'; text?: string }
  | { kind: 'italic'; text?: string }
  | { kind: 'link'; text?: string; url?: string };

export interface RichTextElementSummary {
  counts: RichTextFeatureCounts;
  /** One entry per detected feature. A single rich-text element may contribute several. */
  items: RichTextFeature[];
}

function emptyCounts(): RichTextFeatureCounts {
  return {
    plain: 0,
    code: 0,
    cloze: 0,
    latex: 0,
    image: 0,
    rem: 0,
    alias: 0,
    bold: 0,
    italic: 0,
    link: 0,
    literalBrackets: 0,
  };
}

export function emptyRichTextSummary(): RichTextElementSummary {
  return { counts: emptyCounts(), items: [] };
}

function countLiteralBrackets(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length - 1; index += 1)
    if (text[index] === '[' && text[index + 1] === '[') count += 1;
  return count;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordBrackets(counts: RichTextFeatureCounts, text: string | undefined): void {
  if (text) counts.literalBrackets += countLiteralBrackets(text);
}

function pushCloze(summary: RichTextElementSummary, cId: unknown): void {
  if (typeof cId !== 'string' || !cId) return;
  summary.counts.cloze += 1;
  summary.items.push({ kind: 'cloze', cId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeElement(summary: RichTextElementSummary, element: unknown): void {
  if (typeof element === 'string') {
    summary.counts.plain += 1;
    summary.items.push({ kind: 'plain', text: element });
    recordBrackets(summary.counts, element);
    return;
  }
  if (!isRecord(element)) return;
  const marker = element.i;
  const text = textOf(element.text);
  recordBrackets(summary.counts, text);

  if (marker === 'x') {
    summary.counts.latex += 1;
    summary.items.push({
      kind: 'latex',
      text: text ?? '',
      ...(typeof element.cId === 'string' && element.cId ? { cId: element.cId } : {}),
    });
    pushCloze(summary, element.cId);
    return;
  }
  if (marker === 'i') {
    summary.counts.image += 1;
    summary.items.push({ kind: 'image', url: textOf(element.url) ?? '' });
    if (Array.isArray(element.blocks)) {
      for (const block of element.blocks)
        pushCloze(summary, isRecord(block) ? block.cId : undefined);
    }
    return;
  }
  if (marker === 'q') {
    const id = textOf(element._id);
    if (!id) return;
    summary.counts.rem += 1;
    summary.items.push({ kind: 'rem', id });
    const aliasId = textOf(element.aliasId);
    if (aliasId) {
      summary.counts.alias += 1;
      summary.items.push({ kind: 'alias', id, aliasId });
    }
    pushCloze(summary, element.cId);
    return;
  }
  // Text is `i: 'm'` or an unmarked object. Other markers (card delimiters, unknown) are ignored.
  if (marker !== undefined && marker !== 'm') return;

  const code = element.code === true;
  const bold = element.b === true;
  const italic = element.l === true;
  const url = textOf(element.url) ?? textOf(element.qId);
  const link = Boolean(url);
  if (code) {
    const language = textOf(element.language);
    summary.counts.code += 1;
    summary.items.push({
      kind: 'code',
      text: text ?? '',
      ...(language ? { language } : {}),
    });
  }
  if (bold) {
    summary.counts.bold += 1;
    summary.items.push({ kind: 'bold', ...(text !== undefined ? { text } : {}) });
  }
  if (italic) {
    summary.counts.italic += 1;
    summary.items.push({ kind: 'italic', ...(text !== undefined ? { text } : {}) });
  }
  if (link) {
    summary.counts.link += 1;
    summary.items.push({
      kind: 'link',
      ...(url ? { url } : {}),
      ...(text !== undefined ? { text } : {}),
    });
  }
  pushCloze(summary, element.cId);
  if (!code && !bold && !italic && !link && typeof element.cId !== 'string') {
    summary.counts.plain += 1;
    summary.items.push({ kind: 'plain', text: text ?? '' });
  }
}

/** Summarize one rich-text field. Non-arrays, including absent text, are empty. */
export function summarizeRichText(value: unknown): RichTextElementSummary {
  const summary = emptyRichTextSummary();
  if (!Array.isArray(value)) return summary;
  for (const element of value) summarizeElement(summary, element);
  return summary;
}
