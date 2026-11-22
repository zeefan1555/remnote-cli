import { constants } from 'node:fs';
import { access, lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { buildCliContract } from '../../schemas/contract.js';
import { getSdkCapabilities, localSdkCapabilities } from '../client/sdk-capabilities.js';
import { remnoteCliStateHome } from '../client/state-home.js';
import { PROTOCOL_VERSION } from '../client/connection.js';
import { buildCommandSpecs } from '../spec/command-spec.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as {
  version: string;
  engines: { node: string };
};

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  offline: boolean;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
}

interface DoctorClient {
  execute(action: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface DoctorOptions {
  program: Command;
  client?: DoctorClient;
  offline: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nodeVersionStatus(version: string, engine: string): DoctorCheck {
  const required = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engine);
  if (!required)
    return {
      id: 'node',
      status: 'warn',
      message: 'Unrecognized Node engine policy: ' + engine,
    };
  const current = version.split('.').map(Number);
  const minimum = required.slice(1).map(Number);
  const supported =
    current[0] > minimum[0] ||
    (current[0] === minimum[0] &&
      (current[1] > minimum[1] || (current[1] === minimum[1] && current[2] >= minimum[2])));
  return {
    id: 'node',
    status: supported ? 'pass' : 'fail',
    message: supported
      ? 'Node ' + version + ' satisfies ' + engine
      : 'Node ' + version + ' does not satisfy ' + engine,
    details: { current: version, required: engine },
  };
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function stateDirectoryCheck(stateHome: string): Promise<DoctorCheck> {
  try {
    const stat = await lstat(stateHome);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return {
        id: 'state_directory',
        status: 'fail',
        message: 'State directory is not a regular directory',
        details: { path: stateHome },
      };
    await access(stateHome, constants.W_OK);
    return {
      id: 'state_directory',
      status: 'pass',
      message: 'State directory is writable',
      details: { path: stateHome },
    };
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT')
      return {
        id: 'state_directory',
        status: 'fail',
        message: 'State directory cannot be inspected',
        details: { path: stateHome, error: error instanceof Error ? error.message : String(error) },
      };
  }

  try {
    const parent = await nearestExistingParent(dirname(stateHome));
    await access(parent, constants.W_OK);
    return {
      id: 'state_directory',
      status: 'warn',
      message: 'State directory does not exist yet; nearest parent is writable',
      details: { path: stateHome, writableParent: parent },
    };
  } catch (error) {
    return {
      id: 'state_directory',
      status: 'fail',
      message: 'No writable parent exists for the state directory',
      details: { path: stateHome, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function journalCheck(stateHome: string, knowledgeBaseId: string): Promise<DoctorCheck> {
  const kbKey = createHash('sha256').update(knowledgeBaseId).digest('hex');
  const directory = join(stateHome, 'state', kbKey);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT')
      return {
        id: 'journal',
        status: 'pass',
        message: 'No local journal files exist for this knowledge base',
        details: { directory, files: 0 },
      };
    return {
      id: 'journal',
      status: 'fail',
      message: 'Journal directory cannot be read',
      details: { directory, error: error instanceof Error ? error.message : String(error) },
    };
  }

  const problems: Array<{ file: string; message: string }> = [];
  let files = 0;
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) {
      if (name.endsWith('.tmp'))
        problems.push({ file: name, message: 'Temporary state file remains' });
      continue;
    }
    files += 1;
    const path = join(directory, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        problems.push({ file: name, message: 'Not a regular file' });
        continue;
      }
      if (stat.size > 4 * 1024 * 1024) {
        problems.push({ file: name, message: 'File exceeds 4 MiB' });
        continue;
      }
      if ((stat.mode & 0o077) !== 0) {
        problems.push({ file: name, message: 'File permissions are not private' });
        continue;
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        JSON.parse(await handle.readFile('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      problems.push({
        file: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    id: 'journal',
    status: problems.length === 0 ? 'pass' : 'fail',
    message:
      problems.length === 0
        ? 'Local journals are readable and private'
        : 'One or more local journal files are unhealthy',
    details: { directory, files, problems },
  };
}

function contractCheck(program: Command): DoctorCheck {
  try {
    const specs = buildCommandSpecs(program);
    const contract = buildCliContract(specs);
    return {
      id: 'command_contract',
      status: contract.output.schemaVersion === 2 ? 'pass' : 'fail',
      message:
        contract.output.schemaVersion === 2
          ? 'Command policy and output contract are internally consistent'
          : 'CLI output contract version is unexpected',
      details: { commands: specs.length, outputSchemaVersion: contract.output.schemaVersion },
    };
  } catch (error) {
    return {
      id: 'command_contract',
      status: 'fail',
      message: 'Command schema or policy is inconsistent',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function summarize(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    skip: checks.filter((check) => check.status === 'skip').length,
  };
}

function skippedBridgeChecks(): DoctorCheck[] {
  return [
    'bridge',
    'plugin',
    'protocol',
    'knowledge_base',
    'sdk_catalog',
    'sdk_facts_sync',
    'journal',
  ].map((id) => ({ id, status: 'skip', message: 'Skipped by --offline' }));
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    nodeVersionStatus(process.versions.node, packageJson.engines.node),
    {
      id: 'cli_version',
      status: 'pass',
      message: 'CLI version ' + packageJson.version,
      details: { version: packageJson.version },
    },
  ];
  const stateHome = remnoteCliStateHome();
  checks.push(await stateDirectoryCheck(stateHome));
  checks.push(contractCheck(options.program));
  const localFacts = localSdkCapabilities();
  checks.push({
    id: 'local_sdk_facts',
    status: 'pass',
    message: 'Local SDK facts and generated navigation are readable',
    details: {
      catalogSchemaVersion: localFacts.catalogSchemaVersion,
      sdkVersion: localFacts.sdkVersion,
      catalogHash: localFacts.sdkCatalogHash,
      capabilities: localFacts.capabilities.length,
    },
  });

  if (options.offline || !options.client) {
    checks.push(...skippedBridgeChecks());
  } else {
    let status: Record<string, unknown> | undefined;
    try {
      const value = await options.client.execute('get_status', {});
      if (!isRecord(value)) throw new Error('get_status returned a non-object');
      status = value;
      checks.push({ id: 'bridge', status: 'pass', message: 'Bridge responded to status' });
    } catch (error) {
      checks.push({
        id: 'bridge',
        status: 'fail',
        message: 'Bridge connection failed',
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }

    if (!status) {
      checks.push(
        ...skippedBridgeChecks()
          .slice(1)
          .map((check) => ({ ...check, message: 'Skipped because the Bridge is unavailable' }))
      );
    } else {
      checks.push(
        typeof status.pluginId === 'string'
          ? {
              id: 'plugin',
              status: status.pluginId === 'remnote-cli-bridge' ? 'pass' : 'fail',
              message:
                status.pluginId === 'remnote-cli-bridge'
                  ? 'RemNote CLI Bridge plugin is active'
                  : 'Unexpected plugin identity',
              details: { pluginId: status.pluginId },
            }
          : { id: 'plugin', status: 'fail', message: 'Plugin identity is missing' }
      );
      checks.push({
        id: 'protocol',
        status: status.protocolVersion === PROTOCOL_VERSION ? 'pass' : 'fail',
        message:
          status.protocolVersion === PROTOCOL_VERSION
            ? 'Bridge protocol is compatible'
            : 'Bridge protocol is incompatible',
        details: { expected: PROTOCOL_VERSION, actual: status.protocolVersion },
      });
      checks.push(
        typeof status.knowledgeBaseId === 'string' && status.knowledgeBaseId.length > 0
          ? {
              id: 'knowledge_base',
              status: 'pass',
              message: 'Active knowledge base is identified',
              details: {
                knowledgeBaseId: status.knowledgeBaseId,
                knowledgeBaseName: status.knowledgeBaseName,
              },
            }
          : { id: 'knowledge_base', status: 'fail', message: 'Active knowledge base is missing' }
      );
      if (status.authorizationError !== undefined)
        checks.push({
          id: 'authorization',
          status: 'fail',
          message: 'Bridge reported an authorization error',
          details: { error: status.authorizationError },
        });

      try {
        const catalog = await getSdkCapabilities(options.client);
        checks.push({
          id: 'sdk_catalog',
          status:
            typeof status.sdkCatalogHash === 'string' &&
            status.sdkCatalogHash === catalog.sdkCatalogHash
              ? 'pass'
              : 'fail',
          message:
            typeof status.sdkCatalogHash === 'string' &&
            status.sdkCatalogHash === catalog.sdkCatalogHash
              ? 'Live SDK catalog matches the Bridge identity'
              : 'SDK catalog identity changed or is missing',
          details: {
            sdkVersion: catalog.sdkVersion,
            catalogHash: catalog.sdkCatalogHash,
          },
        });
        checks.push({
          id: 'sdk_facts_sync',
          status: catalog.sdkCatalogHash === localFacts.sdkCatalogHash ? 'pass' : 'warn',
          message:
            catalog.sdkCatalogHash === localFacts.sdkCatalogHash
              ? 'Live SDK facts match the local generated navigation'
              : 'Live SDK facts changed; generated help is stale but sdk call can use supported live capabilities',
          details: {
            localCatalogHash: localFacts.sdkCatalogHash,
            liveCatalogHash: catalog.sdkCatalogHash,
          },
        });
      } catch (error) {
        checks.push({
          id: 'sdk_catalog',
          status: 'fail',
          message: 'SDK catalog cannot be verified',
          details: { error: error instanceof Error ? error.message : String(error) },
        });
      }

      if (typeof status.knowledgeBaseId === 'string')
        checks.push(await journalCheck(stateHome, status.knowledgeBaseId));
      else checks.push({ id: 'journal', status: 'skip', message: 'Knowledge base is unknown' });
    }
  }

  const summary = summarize(checks);
  return {
    schemaVersion: 1,
    ok: summary.fail === 0,
    offline: options.offline,
    checks,
    summary,
  };
}
