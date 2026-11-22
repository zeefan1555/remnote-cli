export type OutputFormat = 'json' | 'text';

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeTerminalText(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

export function formatResult(
  data: unknown,
  format: OutputFormat,
  textFormatter?: (data: unknown) => string
): string {
  if (format === 'json') return JSON.stringify({ schemaVersion: 2, ok: true, data }, null, 2);
  if (textFormatter) return sanitizeTerminalText(textFormatter(data));
  if (data && typeof data === 'object')
    return sanitizeTerminalText(
      Object.entries(data)
        .map(
          ([key, value]) =>
            key + ': ' + (typeof value === 'object' ? JSON.stringify(value) : String(value))
        )
        .join('\n')
    );
  return sanitizeTerminalText(String(data));
}
