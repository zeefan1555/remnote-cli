import { createServer } from 'node:net';
import { readConnectionConfig } from '../../src/remnote-cli/client/connection-config.js';

try {
  const { port, knowledgeBaseId } = await readConnectionConfig();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  console.log(JSON.stringify({ preflight: 'passed', host: '127.0.0.1', port, knowledgeBaseId }));
} catch (error) {
  console.error(
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'Refusing live tests: the paired loopback port is already in use. Identify its owner; no process was stopped.'
      : error instanceof Error
        ? error.message
        : String(error)
  );
  process.exitCode = 1;
}
