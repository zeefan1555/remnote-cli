import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('direct CLI package', () => {
  it('ships only the CLI and has no server runtime or SDK runtime dependency', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(pkg.bin).toEqual({ 'remnote-cli': 'dist/remnote-cli/index.js' });
    expect(lock.packages[''].bin).toEqual(pkg.bin);
    expect(pkg.main).toBe(pkg.bin['remnote-cli']);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['commander', 'ws', 'zod']);
    expect(pkg.scripts.build).toContain('tsc');
    expect(pkg.scripts.build).not.toContain('mcpb');
    for (const file of [
      'src/http-server.ts',
      'src/daemon.ts',
      'mcpb/remnote-local/server/index.js',
    ])
      expect(existsSync(file)).toBe(false);
  });
});
