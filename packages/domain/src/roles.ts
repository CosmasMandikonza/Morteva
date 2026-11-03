/**
 * Actor roles and the pure permission matrix (issue #7).
 *
 * Authority originates ONLY from a persisted, server-verified actor record —
 * never from a client-supplied role string, header, or model output. This
 * table is the single owner of "which role may do what"; every service and
 * route check resolves through it.
 *
 *   owner     full authority including membership management
 *   admin     manages authority (mandates, grants) but is org staff, not founder
 *   approver  may approve permitted financial actions (never their own proposal
 *             where separation of duties applies)
 *   operator  runs mission operations; cannot approve or raise limits
 *   viewer    read-only
 *   service   machine actor: may propose and (with an explicit mission grant)
 *             operate, but can NEVER approve or manage authority
 */
export type ActorRole = 'owner' | 'admin' | 'approver' | 'operator' | 'viewer' | 'service';

export const ACTOR_ROLES: readonly ActorRole[] = [
  'owner',
  'admin',
  'approver',
  'operator',
  'viewer',
  'service',
];

export type ActorKind = 'human' | 'service';

/** Human roles form a simple hierarchy; 'service' is deliberately outside it. */
const HUMAN_RANK: Record<Exclude<ActorRole, 'service'>, number> = {
  owner: 50,
  admin: 40,
  approver: 30,
  operator: 20,
  viewer: 10,
};

function rank(role: ActorRole): number {
  return role === 'service' ? 0 : HUMAN_RANK[role];
}

export function canManageAuthority(role: ActorRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canApproveFinancialActions(role: ActorRole): boolean {
  return rank(role) >= HUMAN_RANK.approver;
}

export function canOperate(role: ActorRole): boolean {
  // service actors operate ONLY with an explicit per-mission grant; the grant
  // itself is checked by the authority service, this flag just admits the role.
  return role === 'service' || rank(role) >= HUMAN_RANK.operator;
}

export function canReadFinancialState(role: ActorRole): boolean {
  return rank(role) >= HUMAN_RANK.viewer || role === 'service';
}

export function canProposePlans(role: ActorRole): boolean {
  return rank(role) >= HUMAN_RANK.operator || role === 'service';
}

export function isActorRole(value: string): value is ActorRole {
  return (ACTOR_ROLES as readonly string[]).includes(value);
}
