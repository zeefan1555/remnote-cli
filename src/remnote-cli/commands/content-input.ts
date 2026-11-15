import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

export const MAX_WRITE_CONTENT_BYTES = 100 * 1024;

function formatLimit(maxBytes: number): string {
  return `${maxBytes / 1024} KB`;
}

function ensureWithinLimit(byteLength: number, sourceLabel: string, maxBytes: number): void {
  if (byteLength > maxBytes) {
    throw new Error(`${sourceLabel} exceeds ${formatLimit(maxBytes)} limit`);
  }
}

async function readUtf8FromStream(
  stream: Readable,
  sourceLabel: string,
  maxBytes: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    ensureWithinLimit(totalBytes, sourceLabel, maxBytes);
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function readContentFileOrStdin(
  pathOrDash: string,
  stdin: Readable = process.stdin,
  maxBytes = MAX_WRITE_CONTENT_BYTES
): Promise<string> {
  if (pathOrDash === '-') {
    return readUtf8FromStream(stdin, 'Stdin content', maxBytes);
  }

  try {
    const buffer = await readFile(pathOrDash);
    ensureWithinLimit(buffer.byteLength, `Content file "${pathOrDash}"`, maxBytes);
    return buffer.toString('utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read content file "${pathOrDash}": ${message}`, {
      cause: error,
    });
  }
}

interface OptionalContentArgs {
  inlineText: string | undefined;
  filePath: string | undefined;
  inlineFlag: string;
  fileFlag: string;
  stdin?: Readable;
}

export async function resolveOptionalInlineOrFileContent({
  inlineText,
  filePath,
  inlineFlag,
  fileFlag,
  stdin,
}: OptionalContentArgs): Promise<string | undefined> {
  if (inlineText !== undefined && filePath !== undefined) {
    throw new Error(`Cannot use ${inlineFlag} and ${fileFlag} together`);
  }
  if (filePath !== undefined) {
    return readContentFileOrStdin(filePath, stdin);
  }

  // convert literal \n strings into actual newline characters
  return inlineText?.replace(/\\n/g, '\n');
}

interface JournalContentArgs {
  positionalContent: string | undefined;
  optionContent: string | undefined;
  contentFile: string | undefined;
  stdin?: Readable;
}

export async function resolveJournalContent({
  positionalContent,
  optionContent,
  contentFile,
  stdin,
}: JournalContentArgs): Promise<string> {
  const providedCount = [positionalContent, optionContent, contentFile].filter(
    (value) => value !== undefined
  ).length;

  if (providedCount !== 1) {
    throw new Error(
      'Provide exactly one journal content source: positional <content>, --content <text>, or --content-file <path|->'
    );
  }

  if (contentFile !== undefined) {
    return readContentFileOrStdin(contentFile, stdin);
  }

  if (optionContent !== undefined) {
    return optionContent;
  }

  return positionalContent as string;
}
