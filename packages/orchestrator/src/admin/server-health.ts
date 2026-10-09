/**
 * Server disk health for the admin Overview. The host's disk guard (infra/vm/
 * hisab-prune.sh) frees space by itself, but a disk that fills for a reason no prune
 * can fix (database growth) must reach a human, and syslog on the VM has no reader.
 * The container's `/` is an overlay on the host's root filesystem, so statfs('/')
 * reports the real host disk. Thresholds match the guard's escalation tiers.
 */
import { statfs } from 'node:fs/promises';
import type { Tone } from './html.js';

export const DISK_WARN_PCT = 75;
export const DISK_CRIT_PCT = 85;

export interface DiskUsage {
  usedPct: number;
  freeBytes: number;
  totalBytes: number;
}

/** Same tiers as the host guard: ok < 75% ≤ warn < 85% ≤ bad. */
export function diskTone(usedPct: number): Tone {
  if (usedPct >= DISK_CRIT_PCT) return 'bad';
  if (usedPct >= DISK_WARN_PCT) return 'warn';
  return 'ok';
}

/** Read disk usage; null when it can't be observed (shown as UNKNOWN, never a crash). */
export async function readDisk(path = '/'): Promise<DiskUsage | null> {
  try {
    const s = await statfs(path);
    // Same formula as `df` (and so as the host guard): used / (used + available), rounded up.
    const used = (s.blocks - s.bfree) * s.bsize;
    const free = s.bavail * s.bsize; // what a non-root process can still write
    if (!(used + free > 0)) return null;
    return {
      usedPct: Math.ceil((used / (used + free)) * 100),
      freeBytes: free,
      totalBytes: s.blocks * s.bsize,
    };
  } catch {
    return null;
  }
}

export function fmtGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
