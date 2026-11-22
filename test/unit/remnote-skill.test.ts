import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('repository RemNote Agent Skill', () => {
  it('documents the version 2 runtime and diagnostic surfaces', async () => {
    const skill = await readFile('skills/remnote/SKILL.md', 'utf8');

    for (const phrase of [
      '"schemaVersion":2',
      'error.details',
      'unknown_outcome',
      'doctor --offline',
      'doctor --text',
      'remnote-cli schema',
      'data.paging.complete=true',
      'exit 5',
    ])
      expect(skill).toContain(phrase);
  });

  it('does not retain the old raw-error or single exit-code guidance', async () => {
    const skill = await readFile('skills/remnote/SKILL.md', 'utf8');

    expect(skill).not.toContain('validation, connection and incomplete-receipt');
    expect(skill).not.toContain('must exit 1');
  });

  it('uses native Rem card commands without task-plan instructions', async () => {
    const skill = await readFile('skills/remnote/SKILL.md', 'utf8');
    for (const command of [
      'rem create',
      'rem update',
      'rem update-answer',
      'rem inspect',
      'sdk card',
    ])
      expect(skill).toContain(command);
    expect(skill).not.toContain('card apply');
    expect(skill).not.toContain('card review-stats');
    expect(skill).not.toContain('task-plans.md');
    expect(skill).not.toContain('--plan');
  });
});
