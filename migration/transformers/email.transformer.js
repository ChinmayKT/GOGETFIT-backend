/**
 * Legacy email_id -> the new `email` field.
 *
 * Trimming is the only transformation. Casing is preserved: nothing in the
 * application normalizes email case, and email is not an identity key here, so
 * lowercasing would be an invented change to source data.
 */
export const transformLegacyEmail = (rawEmail) => {
  if (rawEmail === null || rawEmail === undefined) return null;

  const trimmed = String(rawEmail).trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Groups legacy users by email so duplicates can be reported. Comparison is
 * case-insensitive because "A@x.com" and "a@x.com" are the same mailbox, but
 * the stored value keeps its original casing.
 */
export const groupByEmail = (entries) => {
  const byEmail = new Map();

  for (const entry of entries) {
    const email = transformLegacyEmail(entry.rawEmail);
    if (email === null) continue;

    const key = email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push({ legacyUserId: entry.legacyUserId, email });
  }

  return [...byEmail.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      email: key,
      legacyUserIds: members.map((member) => member.legacyUserId).sort((a, b) => a - b),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
};

export default transformLegacyEmail;
