import { describe, expect, it } from 'vitest';
import { formatResult, sanitizeTerminalText } from '../../../src/remnote-cli/output/formatter.js';

describe('formatResult', () => {
  it('wraps JSON results in the version 2 success envelope', () => {
    const result = formatResult({ key: 'value' }, 'json');
    expect(JSON.parse(result)).toEqual({
      schemaVersion: 2,
      ok: true,
      data: { key: 'value' },
    });
  });

  it('uses text formatters without a JSON envelope', () => {
    const result = formatResult({ name: 'test' }, 'text', (data) => {
      const value = data as { name: string };
      return 'Name: ' + value.name;
    });
    expect(result).toBe('Name: test');
  });

  it('falls back to key-value display in text mode', () => {
    const result = formatResult({ name: 'test', count: 5 }, 'text');
    expect(result).toContain('name: test');
    expect(result).toContain('count: 5');
  });

  it('handles primitive values in text mode', () => {
    expect(formatResult('hello', 'text')).toBe('hello');
  });
});

describe('sanitizeTerminalText', () => {
  it('removes ANSI sequences and terminal control characters', () => {
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m\u0007\nnext')).toBe('red\nnext');
  });

  it('does not alter normal Unicode text', () => {
    expect(sanitizeTerminalText('RemNote 中文 ✓')).toBe('RemNote 中文 ✓');
  });
});
