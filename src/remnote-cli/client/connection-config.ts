import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const ConnectionConfigSchema = z
  .object({
    protocolVersion: z.literal(1),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    knowledgeBaseId: z.string().min(1).max(256),
    port: z.number().int().min(1024).max(65535).default(3002),
    settings: z
      .object({
        autoTagEnabled: z.boolean().optional(),
        autoTagRemId: z.string().optional(),
        journalPrefix: z.string().optional(),
        journalTimestamp: z.boolean().optional(),
        defaultParentId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
export function connectionConfigPath(): string {
  return (
    process.env.REMNOTE_CLI_CONFIG ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'remnote-cli',
      'connection.json'
    )
  );
}
export async function readConnectionConfig(
  path = connectionConfigPath()
): Promise<ConnectionConfig> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0)
      throw new Error('Pairing file must be a private regular file (chmod 600), at most 8 KiB');
    return ConnectionConfigSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}
export async function createPairing(
  knowledgeBaseId: string,
  port = 3002,
  path = connectionConfigPath()
): Promise<string> {
  const config = ConnectionConfigSchema.parse({
    protocolVersion: 1,
    token: randomBytes(32).toString('hex'),
    knowledgeBaseId,
    port,
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(config, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
