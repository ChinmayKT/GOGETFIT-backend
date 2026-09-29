/**
 * The four roles are ADDITIVE, not mutually exclusive: a single account can be
 * a member, a paying client, a coach and an administrator at the same time.
 * That is why `User.roles` is an array and never a single enum.
 *
 * "user" is the baseline every account carries. The other three are grants.
 */
export const ROLE_USER = 'user';
export const ROLE_CLIENT = 'client';
export const ROLE_COACH = 'coach';
export const ROLE_ADMIN = 'admin';

export const ROLES = [ROLE_USER, ROLE_CLIENT, ROLE_COACH, ROLE_ADMIN];

/** Roles an administrator may grant. "user" is implicit and never granted. */
export const GRANTABLE_ROLES = [ROLE_CLIENT, ROLE_COACH, ROLE_ADMIN];

export const isKnownRole = (role) => ROLES.includes(role);

/**
 * Merges roles into an existing array without duplicating, always keeping
 * "user" present and the result in canonical ROLES order so that stored
 * documents do not differ only by ordering.
 */
export const mergeRoles = (existing = [], additions = []) => {
  const set = new Set([ROLE_USER, ...existing, ...additions].filter(isKnownRole));
  return ROLES.filter((role) => set.has(role));
};

export const hasRole = (user, role) => Array.isArray(user?.roles) && user.roles.includes(role);

export const hasAnyRole = (user, roles = []) => roles.some((role) => hasRole(user, role));
