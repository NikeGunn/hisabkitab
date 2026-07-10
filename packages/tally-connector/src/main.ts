/**
 * HisabKitab Tally Connector — runs on the SAME computer as TallyPrime and only
 * dials OUT (no inbound ports, no firewall rules). Setup is one step: start it and
 * type the setup code from WhatsApp; it swaps the code for a device token and saves
 * `connector.config.json` next to itself. From then on it long-polls for allowlisted
 * read jobs, runs them against localhost TallyPrime, and posts validated results.
 *
 *   HISAB_SERVER_URL   server base (default https://api.hisabkitab.pro/tally)
 *   HISAB_SETUP_CODE   one-time setup code (or pass as the first CLI argument)
 *   TALLY_URL          TallyPrime XML server (default http://localhost:9000)
 *   TALLY_SIMULATOR=1  use the built-in simulator instead of real Tally (dev only;
 *                      results are flagged and REJECTED by production)
 *
 * Logs are redacted by design: no tokens, no ledger bodies — operations and counts only.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { TallyClient } from './tally-client.js';
import { executeOperation, OperationError } from './operations.js';
import { startSimulator, type SimulatorHandle } from './simulator.js';

export const CONNECTOR_VERSION = '0.1.0';
const CONFIG_FILE = 'connector.config.json';
const DEFAULT_SERVER = 'https://api.hisabkitab.pro/tally';
const DEFAULT_TALLY = 'http://localhost:9000';

interface ConnectorConfig {
  server_url: string;
  connector_token: string;
}

const log = (msg: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

async function loadConfig(): Promise<ConnectorConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<ConnectorConfig>;
    if (typeof parsed.server_url === 'string' && typeof parsed.connector_token === 'string') {
      return { server_url: parsed.server_url, connector_token: parsed.connector_token };
    }
  } catch {
    /* first run */
  }
  return null;
}

async function register(serverUrl: string, setupCode: string): Promise<ConnectorConfig> {
  const res = await fetch(`${serverUrl}/connector/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setup_code: setupCode, connector_version: CONNECTOR_VERSION }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'That setup code is not valid (or expired). Ask HisabKitab on WhatsApp for a fresh one.'
        : `registration failed (HTTP ${res.status})`,
    );
  }
  const body = (await res.json()) as { connector_token: string };
  const config: ConnectorConfig = { server_url: serverUrl, connector_token: body.connector_token };
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  log('registered — config saved', { file: CONFIG_FILE });
  return config;
}

async function promptSetupCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      'Type the setup code HisabKitab sent you on WhatsApp (e.g. AB2CD3EF): ',
    );
    return answer.trim();
  } finally {
    rl.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runConnector(): Promise<void> {
  const serverUrl = (process.env['HISAB_SERVER_URL'] ?? DEFAULT_SERVER).replace(/\/$/, '');
  const simulator: SimulatorHandle | null =
    process.env['TALLY_SIMULATOR'] === '1' ? await startSimulator() : null;
  const isSimulator = simulator !== null;
  const tallyUrl = simulator?.url ?? process.env['TALLY_URL'] ?? DEFAULT_TALLY;
  const client = new TallyClient({ baseUrl: tallyUrl });

  let config = await loadConfig();
  if (!config) {
    const code = process.env['HISAB_SETUP_CODE'] ?? process.argv[2] ?? (await promptSetupCode());
    if (!code) throw new Error('a setup code is required for the first run');
    config = await register(serverUrl, code);
  }

  log('connector started', {
    server: config.server_url,
    tally: isSimulator ? 'SIMULATOR' : tallyUrl,
    version: CONNECTOR_VERSION,
  });

  const authHeaders = {
    authorization: `Bearer ${config.connector_token}`,
    'content-type': 'application/json',
    'x-connector-version': CONNECTOR_VERSION,
  };

  for (;;) {
    try {
      const claim = await fetch(`${config.server_url}/connector/claim`, {
        method: 'POST',
        headers: authHeaders,
        body: '{}',
      });
      if (claim.status === 401) {
        log(
          'token rejected — this connector was revoked. Ask for a new setup code and delete connector.config.json',
        );
        await sleep(60_000);
        continue;
      }
      if (!claim.ok) {
        log('claim failed, backing off', { status: claim.status });
        await sleep(5_000);
        continue;
      }
      const { job } = (await claim.json()) as {
        job: { id: string; operation: string; params: unknown } | null;
      };
      if (!job) continue; // long-poll answered "nothing to do" — poll again

      log('job claimed', { job_id: job.id, operation: job.operation });
      const started = Date.now();
      let envelope: Record<string, unknown>;
      try {
        const result = await executeOperation(client, job.operation, job.params);
        envelope = {
          op: job.operation,
          ok: true,
          simulator: isSimulator,
          ...(result.companySourceId ? { company_source_id: result.companySourceId } : {}),
          payload: result.payload,
          duration_ms: Date.now() - started,
          connector_version: CONNECTOR_VERSION,
        };
      } catch (err) {
        const message =
          err instanceof OperationError ? err.message : 'operation failed on the Tally side';
        envelope = {
          op: job.operation,
          ok: false,
          simulator: isSimulator,
          error: message.slice(0, 500),
          duration_ms: Date.now() - started,
          connector_version: CONNECTOR_VERSION,
        };
      }
      const post = await fetch(`${config.server_url}/connector/result`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ job_id: job.id, envelope }),
      });
      log('result posted', { job_id: job.id, ok: envelope['ok'], status: post.status });
    } catch (err) {
      log('poll loop error, backing off', { error: (err as Error).message });
      await sleep(5_000);
    }
  }
}

// Direct run (tsx src/main.ts). pathToFileURL dance not needed here — this file is
// the connector's only entrypoint and never imported by the server services.
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  runConnector().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
