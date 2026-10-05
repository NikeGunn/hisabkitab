/**
 * Print an ADMIN_PASSWORD_HASH for the admin panel.
 *   pnpm --filter @hisab/orchestrator admin:hash            (prompts on stdin)
 *   echo -n 'long passphrase' | pnpm ... admin:hash
 * The password itself is never written anywhere; put only the printed hash in the
 * server's .env.
 */
import { hashPassword } from './auth.js';

const chunks: Buffer[] = [];
if (process.stdin.isTTY) process.stderr.write('Admin password (min 12 chars), then Enter: ');
for await (const c of process.stdin) {
  chunks.push(c as Buffer);
  if (process.stdin.isTTY && String(c).includes('\n')) break;
}
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
console.log(await hashPassword(password));
