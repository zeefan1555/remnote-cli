import { createServer } from 'node:net';

try {
  const port = Number(process.env.REMNOTE_CLI_TEST_PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid integration-test port');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  console.log(JSON.stringify({ preflight: 'passed', host: '127.0.0.1', port }));
} catch (error) {
  console.error(
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'Refusing live tests: the loopback port is already in use. Identify its owner; no process was stopped.'
      : error instanceof Error
        ? error.message
        : String(error)
  );
  process.exitCode = 1;
}
