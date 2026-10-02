import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, formatError, type OutputFormat } from '../output/formatter.js';
import { EXIT } from '../config.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check bridge connection status')
    .action(async () => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const result = await client.execute('get_status', {});
        console.log(
          formatResult(result, format, (data) => {
            const r = data as Record<string, unknown>;
            const connected = r.connected ? 'Connected' : 'Not connected';
            const pluginVersion = r.pluginVersion ? ` (plugin v${r.pluginVersion})` : '';
            const cliVersion = r.cliVersion ? `CLI: v${r.cliVersion}` : '';
            const lines = [`Bridge: ${connected}${pluginVersion}`];
            if (r.pluginId) lines.push(`Plugin ID: ${r.pluginId}`);
            if (cliVersion) lines.push(cliVersion);
            if (r.knowledgeBaseId) lines.push(`KB: ${r.knowledgeBaseName} (${r.knowledgeBaseId})`);
            if (r.protocolVersion) lines.push(`Protocol: ${r.protocolVersion}`);
            if (r.sdkVersion) lines.push(`SDK: ${r.sdkVersion}`);
            if (r.authorizationError) lines.push(`Authorization: ${r.authorizationError}`);
            return lines.join('\n');
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(formatError(message, format));
        process.exitCode = EXIT.ERROR;
      } finally {
        await client.close();
      }
    });
}
