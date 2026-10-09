/**
 * The owner's team commands over WhatsApp — handled BEFORE the agent turn so the
 * model never sees them as a normal request and a non-owner can never change the
 * team. Authority comes from the verified membership, never the message text.
 *
 *   add 98XXXXXXXX as auditor [for 30 days]   invite (invitee replies JOIN)
 *   change 98XXXXXXXX to viewer               change a current member's role
 *   remove 98XXXXXXXX                         take access away / cancel invite
 *   team                                      who has access right now
 */
import type { Db } from '@hisab/db';
import { planName, type Role } from '@hisab/shared';
import {
  changeMember,
  INVITE_TTL_DAYS,
  inviteMember,
  listTeam,
  MAX_ACCESS_DAYS,
  removeMember,
  ROLE_ACCESS,
  withArticle,
  type ResolvedMembership,
  type TeamCommand,
} from './membership.js';

export const TEAM_HELP =
  'Team commands (owner only):\n' +
  '• add 98XXXXXXXX as accountant / auditor / staff / viewer\n' +
  '• add 98XXXXXXXX as auditor for 30 days\n' +
  '• change 98XXXXXXXX to viewer\n' +
  '• remove 98XXXXXXXX\n' +
  '• team (see who has access)';

/** YYYY-MM-DD in Nepal time, for "access until …". */
export const npDate = (d: Date): string => new Date(d.getTime() + 345 * 60_000).toISOString().slice(0, 10);

const NOT_OWNER = 'Only the business owner can manage the team. Please ask the owner to do this.';

export interface TeamChatDeps {
  db: Db;
  /** Send the approved `team_invite` template (the invitee has never messaged us). Must not throw. */
  sendInvite(to: string, businessName: string, role: Role): Promise<void>;
}

/** Run one team command for `member` and return the reply to send them. */
export async function handleTeamCommand(deps: TeamChatDeps, member: ResolvedMembership, cmd: TeamCommand): Promise<string> {
  const actor = { via: 'chat', member } as const;
  switch (cmd.kind) {
    case 'malformed':
      return cmd.hint === 'days'
        ? `Access can be limited to 1 to ${MAX_ACCESS_DAYS} days, e.g. "add 98XXXXXXXX as auditor for 30 days". Leave out "for … days" for access until you remove it.`
        : `I couldn't read that phone number. Use a WhatsApp mobile number, e.g. 98XXXXXXXX.\n\n${TEAM_HELP}`;

    case 'list': {
      if (member.role !== 'owner') return NOT_OWNER;
      const rows = (await listTeam(deps.db, member.tenantId)).filter((r) => r.role !== 'owner');
      if (rows.length === 0) return `Only you have access to ${member.businessName}.\n\n${TEAM_HELP}`;
      const lines = rows.map((r) => {
        const until = r.expiresAt ? `, until ${npDate(r.expiresAt)}` : '';
        return `• ${r.e164}: ${r.role}${r.status === 'invited' ? ' (invite not accepted yet)' : ''}${until}`;
      });
      return `People with access to ${member.businessName}:\n${lines.join('\n')}\n\nTo take access away: "remove <number>".`;
    }

    case 'invite': {
      const res = await inviteMember(deps.db, actor, cmd.e164, cmd.role, { days: cmd.days });
      switch (res.kind) {
        case 'invited': {
          // The invite row exists either way and JOIN still works; sendInvite logs a failure.
          await deps.sendInvite(res.inviteE164, res.businessName, res.role);
          const until = res.expiresAt ? ` Their access ends on ${npDate(res.expiresAt)}.` : '';
          return (
            `Invite sent to ${res.inviteE164} as ${res.role}. 🙌 They reply "JOIN" from that number within ` +
            `${INVITE_TTL_DAYS} days to accept. They can ${ROLE_ACCESS[res.role]}.${until}`
          );
        }
        case 'already_member':
          return `That number is already on your team as ${res.role}. To change it: "change ${cmd.e164} to viewer".`;
        case 'busy_elsewhere':
          return 'That number already uses HisabKitab for another business, so it cannot join yours yet. Please use a different WhatsApp number for them.';
        case 'seat_limit':
          return (
            `Your ${planName(res.plan)} plan includes ${res.seats} ${res.seats === 1 ? 'person' : 'people'} (you included), and all are in use. ` +
            'Remove someone ("remove <number>") or move to a bigger plan to add more.'
          );
        case 'role_not_in_plan':
          return `Adding ${withArticle(res.role)} needs the ${res.minPlan ? planName(res.minPlan) : 'a higher'} plan or above. You can add an auditor, staff or viewer if you have a free seat.`;
        case 'not_owner':
          return NOT_OWNER;
        case 'tenant_inactive':
          return 'Your business is not active right now, so the team cannot be changed.';
        case 'bad_role':
        case 'bad_days':
        case 'bad_number':
          return TEAM_HELP;
      }
      break;
    }

    case 'change': {
      const res = await changeMember(deps.db, actor, cmd.e164, { role: cmd.role });
      switch (res.kind) {
        case 'changed':
          return `${res.e164} is now ${withArticle(res.role)}. They can ${ROLE_ACCESS[res.role]}.`;
        case 'not_found':
          return `${cmd.e164} is not on your team right now. Type "team" to see who is.`;
        case 'is_owner':
          return 'The owner role cannot be changed by message.';
        case 'role_not_in_plan':
          return `Making someone ${withArticle(res.role)} needs the ${res.minPlan ? planName(res.minPlan) : 'a higher'} plan or above.`;
        case 'not_owner':
          return NOT_OWNER;
        default:
          return TEAM_HELP;
      }
    }

    case 'remove': {
      const res = await removeMember(deps.db, actor, cmd.e164);
      switch (res.kind) {
        case 'removed':
          return `Done. ${res.e164} (${res.role}) no longer has access to ${member.businessName}.`;
        case 'not_found':
          return `${cmd.e164} is not on your team. Type "team" to see who is.`;
        case 'is_owner':
          return 'The owner cannot be removed.';
        case 'not_owner':
          return NOT_OWNER;
        case 'bad_number':
          return TEAM_HELP;
      }
    }
  }
  return TEAM_HELP;
}

/** Welcome a newly joined member, stating their (limited) access. */
export function memberWelcome(businessName: string, role: Role, expiresAt: Date | null): string {
  const until = expiresAt ? ` Your access ends on ${npDate(expiresAt)}.` : '';
  return (
    `You've joined ${businessName} as ${role}. 🎉 You can ${ROLE_ACCESS[role]}. ` +
    `Money actions and team changes stay with the owner.${until}`
  );
}

/** A former member messages after their access ended. */
export function endedAccessReply(businessName: string, why: 'expired' | 'removed'): string {
  return (
    `Your access to ${businessName} ${why === 'expired' ? 'has ended' : 'was removed by the owner'}. ` +
    'Ask the owner if you need it again. To use HisabKitab for your own business, apply at hisabkitab.pro/pilot.'
  );
}
