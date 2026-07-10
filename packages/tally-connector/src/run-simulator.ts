/** Run the Tally simulator standalone (dev): `pnpm --filter @hisab/tally-connector simulate`. */
import { startSimulator } from './simulator.js';

const port = Number(process.env['SIMULATOR_PORT'] ?? 9009);
const handle = await startSimulator(port);
console.log(`Tally SIMULATOR listening on ${handle.url} (never claims to be real Tally)`);
