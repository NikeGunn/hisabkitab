/**
 * RBAC core (PRD v2.0 §3) — PURE, no IO. The SINGLE source of truth for
 * "which role may do what", reused by the MCP tools (server-side enforcement),
 * the orchestrator (command gating) and CI. Deny-by-default.
 *
 * The role NEVER comes from a tool argument or the model — it travels inside the
 * HMAC-signed session token (mcp-ledger/auth.ts) and is checked here. This mirrors
 * the tenant-isolation invariant: identity is derived from verified metadata only.
 *
 * Design: each role's allowed capabilities are packed into a bitmask, so `can()`
 * is one O(1) bitwise-AND — no array scans, and the whole matrix is a tiny table.
 */

/** A membership role. Order = privilege, but capability is decided by the matrix. */
export type Role = 'owner' | 'accountant' | 'staff' | 'viewer';

/** Server-enforced capabilities (PRD §3 matrix rows). */
export type Capability =
  | 'record_entry' // create a draft sale/expense/AR/AP/payment
  | 'confirm_entry' // flip a draft to confirmed (saves money)
  | 'generate_report' // pull statements / PDF reports / summaries
  | 'prepare_vat' // prepare / mark a VAT return
  | 'move_money' // initiate / refund a payment
  | 'manage_billing' // subscription + user management;

/** Stable bit per capability (used to pack the per-role masks below). */
const BIT: Record<Capability, number> = {
  record_entry: 1 << 0,
  confirm_entry: 1 << 1,
  generate_report: 1 << 2,
  prepare_vat: 1 << 3,
  move_money: 1 << 4,
  manage_billing: 1 << 5,
};

export const ROLES: readonly Role[] = ['owner', 'accountant', 'staff', 'viewer'];
export const CAPABILITIES = Object.keys(BIT) as readonly Capability[];

/** Pack a capability list into a single mask (build-time only). */
const mask = (...caps: Capability[]): number => caps.reduce((m, c) => m | BIT[c], 0);

/**
 * The PRD §3 permission matrix, as one bitmask per role:
 *   | Capability        | Owner | Accountant | Staff | Viewer |
 *   | record (draft)    |  ✅   |    ✅      |  ✅   |   ❌   |
 *   | confirm (save)    |  ✅   |    ✅      |  ❌   |   ❌   |
 *   | generate report   |  ✅   |    ✅      |  ❌   |   ✅   |
 *   | prepare VAT       |  ✅   |    ✅      |  ❌   |   ❌   |
 *   | move money        |  ✅   |    ❌      |  ❌   |   ❌   |
 *   | manage users/bill |  ✅   |    ❌      |  ❌   |   ❌   |
 */
const ROLE_MASK: Record<Role, number> = {
  owner: mask('record_entry', 'confirm_entry', 'generate_report', 'prepare_vat', 'move_money', 'manage_billing'),
  accountant: mask('record_entry', 'confirm_entry', 'generate_report', 'prepare_vat'),
  staff: mask('record_entry'),
  viewer: mask('generate_report'),
};

/**
 * True if `role` is a real role. Uses `Object.hasOwn` (NOT the `in` operator) so
 * inherited keys like `constructor`/`toString`/`__proto__` are never mistaken for
 * roles — important because this guards token minting/verification.
 */
export function isRole(role: string): role is Role {
  return Object.hasOwn(ROLE_MASK, role);
}

/**
 * Can `role` perform `cap`? Deny-by-default: only a real own-key role gets its
 * mask; anything else (a fabricated/inherited-key claim) is refused every
 * capability. Goes through `isRole` so prototype keys can never leak a mask.
 */
export function can(role: string, cap: Capability): boolean {
  if (!isRole(role)) return false;
  return (ROLE_MASK[role] & BIT[cap]) !== 0;
}

export class RoleError extends Error {
  constructor(
    readonly role: string,
    readonly capability: Capability,
  ) {
    super(`role "${role}" is not permitted to ${capability}`);
    this.name = 'RoleError';
  }
}

/** Throw `RoleError` unless `role` may perform `cap`. The server-side gate. */
export function assertCan(role: string, cap: Capability): void {
  if (!can(role, cap)) throw new RoleError(role, cap);
}
