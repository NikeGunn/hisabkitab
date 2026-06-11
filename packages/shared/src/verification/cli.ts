/**
 * Runtime verification CLI — `pnpm verify`.
 * Same checks vitest runs, observed live. Exit code is non-zero on FAIL **or**
 * BLOCKED: when in doubt, do not pass (CLAUDE.md §8).
 */
import { checks } from './checks.js';
import { runCheck, type Verdict } from './verdict.js';

const ICONS: Record<Verdict, string> = { PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLCK', SKIP: 'SKIP' };

let failCount = 0;
let blockedCount = 0;

console.log('HisabKitab Phase 0 verification — fixtures + adversarial probes\n');

for (const check of checks) {
  const result = runCheck(check);
  if (result.verdict === 'FAIL') failCount++;
  if (result.verdict === 'BLOCKED') blockedCount++;
  const tag = check.kind === 'probe' ? 'probe' : 'happy';
  console.log(`[${ICONS[result.verdict]}] ${check.unit.padEnd(10)} ${tag.padEnd(5)} ${check.name}`);
  console.log(`       ${result.detail}\n`);
}

const total = checks.length;
const probeCount = checks.filter((c) => c.kind === 'probe').length;
console.log(
  `${total} checks (${probeCount} adversarial probes): ${total - failCount - blockedCount} PASS, ${failCount} FAIL, ${blockedCount} BLOCKED`,
);

if (failCount > 0 || blockedCount > 0) {
  console.error('\nVerdict: DO NOT SHIP — a FAIL means a unit accepted a lie; BLOCKED means we could not observe.');
  process.exitCode = 1;
} else {
  console.log('\nVerdict: PASS — every unit caught its adversarial probe.');
}
