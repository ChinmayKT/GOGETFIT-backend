import Coach from '../../src/models/coach.model.js';
import User from '../../src/models/user.model.js';

/**
 * Legacy coach (m_coach name / email) -> new Coach._id.
 *
 * The ONE mapping every migration uses to turn a legacy coach into a coachId:
 * the enrolled-clients migration (when linking coaches) and the
 * link-legacy-coaches script. It is a migration tool only - the running
 * application never looks coaches up by legacy name or email; once linked,
 * EnrolledClient.coachId is the relationship.
 *
 * Order and rules, deliberately strict - a wrong coach is worse than none:
 *   1. exact email   - the legacy coach email equals one new coach's user email
 *   2. exact name    - the normalized legacy name equals one new coach's name
 * Normalization only: trim, lower-case, repeated whitespace collapsed (and,
 * for names, the dots/commas of initials). No fuzzy or partial matching.
 *
 * A coach is assigned only when exactly ONE new coach matches and nothing
 * contradicts it. Otherwise the result says why:
 *   unmatched  - nothing matches (or there is no name/email to match on)
 *   ambiguous  - several coaches match the email, or several match the name
 *   conflict   - the email points at one coach and the name at another, or
 *                the name-matched coach has a different email on record
 */

export const normalizeEmail = (value) => {
  const email = String(value ?? '').trim().toLowerCase();
  return email === '' ? null : email;
};

export const normalizeName = (value) => {
  const name = String(value ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ') // "Prajwal A.T." == "prajwal a t"
    .replace(/\s+/g, ' ')
    .trim();
  return name === '' ? null : name;
};

const pushTo = (map, key, value) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

/**
 * Every new coach, indexed by normalized email and name. Built from the Coach
 * documents and their users (a Coach has no name or email of its own).
 */
export const buildCoachDirectory = async ({ session = null } = {}) => {
  const coaches = await Coach.find({}, { userId: 1, status: 1 }).session(session).lean();
  const users = await User.find({ _id: { $in: coaches.map((c) => c.userId) } }, { 'profile.name': 1, 'profile.email': 1 })
    .session(session)
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const entries = coaches.map((c) => {
    const user = userById.get(String(c.userId));
    return {
      coachId: c._id,
      name: user?.profile?.name ?? null,
      email: user?.profile?.email ?? null,
      status: c.status ?? null,
    };
  });

  return directoryFrom(entries);
};

/** The lookup indexes for a list of { coachId, name, email } (pure - testable without a database). */
export const directoryFrom = (entries) => {
  const byEmail = new Map();
  const byName = new Map();
  for (const entry of entries) {
    pushTo(byEmail, normalizeEmail(entry.email), entry);
    pushTo(byName, normalizeName(entry.name), entry);
  }
  return { entries, byEmail, byName, ids: new Set(entries.map((e) => String(e.coachId))) };
};

const brief = (e) => ({ coachId: String(e.coachId), name: e.name, email: e.email });

/**
 * Resolves one legacy coach. Never guesses: see the rules above.
 *
 * @returns {{ status: 'matched', coach, by: 'email'|'name' }
 *         | { status: 'unmatched' | 'ambiguous' | 'conflict', reason, candidates }}
 */
export const resolveLegacyCoach = ({ name, email }, directory) => {
  const legacyEmail = normalizeEmail(email);
  const legacyName = normalizeName(name);
  if (!legacyEmail && !legacyName) {
    return { status: 'unmatched', reason: 'no legacy coach name or email', candidates: [] };
  }

  const emailMatches = legacyEmail ? (directory.byEmail.get(legacyEmail) ?? []) : [];
  const nameMatches = legacyName ? (directory.byName.get(legacyName) ?? []) : [];

  if (emailMatches.length > 1) {
    return { status: 'ambiguous', reason: `${emailMatches.length} coaches share the email ${legacyEmail}`, candidates: emailMatches.map(brief) };
  }

  if (emailMatches.length === 1) {
    const coach = emailMatches[0];
    // The name may differ ("Prajwal A T" vs "Prajwal") - that alone is fine.
    // It only contradicts when it points unambiguously at a DIFFERENT coach.
    if (nameMatches.length === 1 && String(nameMatches[0].coachId) !== String(coach.coachId)) {
      return {
        status: 'conflict',
        reason: 'the email matches one coach and the name another',
        candidates: [brief(coach), brief(nameMatches[0])],
      };
    }
    return { status: 'matched', coach: brief(coach), by: 'email' };
  }

  if (nameMatches.length > 1) {
    return { status: 'ambiguous', reason: `${nameMatches.length} coaches are named "${name}"`, candidates: nameMatches.map(brief) };
  }

  if (nameMatches.length === 1) {
    const coach = nameMatches[0];
    // Same name but a different email on both sides: possibly another person.
    const coachEmail = normalizeEmail(coach.email);
    if (legacyEmail && coachEmail && coachEmail !== legacyEmail) {
      return {
        status: 'conflict',
        reason: `the name matches, but the coach's email (${coachEmail}) differs from the legacy email (${legacyEmail})`,
        candidates: [brief(coach)],
      };
    }
    return { status: 'matched', coach: brief(coach), by: 'name' };
  }

  return { status: 'unmatched', reason: 'no new coach with this email or name', candidates: [] };
};

export default { normalizeEmail, normalizeName, buildCoachDirectory, directoryFrom, resolveLegacyCoach };
