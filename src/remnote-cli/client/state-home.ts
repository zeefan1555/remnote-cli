import { homedir } from 'node:os';
import { join } from 'node:path';

/** Standard per-user state. Tests override this path instead of editing user files. */
export function remnoteCliStateHome(): string {
  return (
    process.env.REMNOTE_CLI_STATE_HOME ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'remnote-cli')
  );
}
