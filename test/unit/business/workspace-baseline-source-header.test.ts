import { describe, expect, it } from 'vitest';
import { preserveSourceHeader } from '../../../src/business/workspace/baseline-source-header.js';

const marker = '<!-- remnote:root -->\n\n';
const rendered = `${marker}# Example\n\n- updated ^node\n`;

describe('one-time native source adoption headers', () => {
  it('preserves unrelated attributes, comments and the original binding prefix', () => {
    const header =
      '---\n# rationale\naliases: [Search] # alias note\ntags: [HOME/old] # tag note\n---\n\n';
    const source = `${header}${marker}# Example\n\n- old ^node\n`;
    const result = preserveSourceHeader('example.md', source, rendered, ['HOME/new']);
    expect(result).toBe(
      `${header.replace('[HOME/old]', '["HOME/new"]')}${marker}# Example\n\n- updated ^node\n`
    );
  });

  it('retains the exact header when tags do not change', () => {
    const source = `---\n# keep this\ntags: [HOME/one] # note\n---\n\n${marker}# Example\n\n- old ^node\n`;
    const result = preserveSourceHeader('example.md', source, rendered, ['HOME/one']);
    expect(result).toBe(source.replace('- old ^node', '- updated ^node'));
  });

  it('inserts a new root tag without changing existing comments', () => {
    const source = `---\n# rationale\naliases: [Search] # note\n---\n\n${marker}# Example\n\n- old ^node\n`;
    const result = preserveSourceHeader('example.md', source, rendered, ['HOME/new']);
    expect(result).toContain('# rationale\naliases: [Search] # note\ntags: ["HOME/new"]\n');
    expect(result).toContain('- updated ^node');
  });

  it('refuses replacing tag items whose comments cannot be retained', () => {
    const source = `---\ntags:\n  - HOME/one # explanation\n  - HOME/two\n---\n\n${marker}# Example\n\n- old ^node\n`;
    expect(() => preserveSourceHeader('example.md', source, rendered, ['HOME/new'])).toThrow(
      'without losing internal comments'
    );
  });

  it('preserves a BOM and CRLF style when adding a header', () => {
    const source = '\uFEFF<!-- remnote:root -->\r\n\r\n# Example\r\n\r\n- old ^node\r\n';
    const result = preserveSourceHeader('example.md', source, rendered, ['HOME/new']);
    expect(result).toBe(
      '\uFEFF---\r\ntags: ["HOME/new"]\r\n---\r\n<!-- remnote:root -->\r\n\r\n# Example\r\n\r\n- updated ^node\r\n'
    );
  });
});
