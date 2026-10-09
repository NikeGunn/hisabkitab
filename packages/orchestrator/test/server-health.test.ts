/** Disk tiers must match the host guard (infra/vm/hisab-prune.sh: WARN=75, CRIT=85). */
import { describe, expect, it } from 'vitest';
import { DISK_CRIT_PCT, DISK_WARN_PCT, diskTone, readDisk } from '../src/admin/server-health.js';

describe('diskTone', () => {
  it('boundaries: 74 ok, 75 warn, 84 warn, 85 bad, 100 bad', () => {
    expect([74, 75, 84, 85, 100].map(diskTone)).toEqual(['ok', 'warn', 'warn', 'bad', 'bad']);
    expect([DISK_WARN_PCT, DISK_CRIT_PCT]).toEqual([75, 85]);
  });
});

describe('readDisk', () => {
  it('reads a real filesystem with sane numbers', async () => {
    const d = await readDisk(process.cwd());
    expect(d).not.toBeNull();
    expect(d!.usedPct).toBeGreaterThanOrEqual(0);
    expect(d!.usedPct).toBeLessThanOrEqual(100);
    expect(d!.totalBytes).toBeGreaterThan(d!.freeBytes);
  });

  it('PROBE: an unreadable path yields null (UNKNOWN), never throws', async () => {
    await expect(readDisk('/definitely/not/a/real/path/xyz')).resolves.toBeNull();
  });
});
