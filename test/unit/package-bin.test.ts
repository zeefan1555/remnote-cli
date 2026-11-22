import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('direct CLI package', () => {
  it('ships only the CLI and has no server runtime or SDK runtime dependency', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe('0.28.2');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(pkg.bin).toEqual({ 'remnote-cli': 'dist/remnote-cli/index.js' });
    expect(lock.packages[''].bin).toEqual(pkg.bin);
    expect(pkg.main).toBe(pkg.bin['remnote-cli']);
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'commander',
      'fflate',
      'mdast-util-from-markdown',
      'mdast-util-to-markdown',
      'ws',
      'yaml',
      'zod',
    ]);
    expect(pkg.scripts.build).toContain('tsc');
    expect(pkg.scripts.build).not.toContain('mcpb');
    expect(pkg.scripts['test:bin']).toBe('node scripts/smoke-built-cli.mjs');
    expect(pkg.scripts).not.toHaveProperty('prepublishOnly');
    for (const field of ['files', 'repository', 'bugs', 'homepage', 'keywords'])
      expect(pkg).not.toHaveProperty(field);
    for (const file of [
      'src/http-server.ts',
      'src/daemon.ts',
      'mcpb/remnote-local/server/index.js',
    ])
      expect(existsSync(file)).toBe(false);
  });
});
