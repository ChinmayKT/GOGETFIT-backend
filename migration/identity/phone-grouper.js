/**
 * Groups transformed legacy users by their normalized phone. This runs BEFORE
 * any Mongo identity is created, because the new system requires one phone per
 * user while the legacy database does not guarantee it.
 */
export const groupByNormalizedPhone = (transformedUsers) => {
  const byPhone = new Map();
  const unusable = [];

  for (const transformed of transformedUsers) {
    if (!transformed.phone.ok) {
      unusable.push(transformed);
      continue;
    }

    const key = transformed.phone.normalized;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(transformed);
  }

  const unique = [];
  const duplicates = [];

  for (const [phone, members] of byPhone.entries()) {
    if (members.length === 1) {
      unique.push(members[0]);
    } else {
      // Stable ordering so reports and conflicts are reproducible across runs.
      duplicates.push({
        phone,
        members: [...members].sort((a, b) => a.legacyUserId - b.legacyUserId),
      });
    }
  }

  unique.sort((a, b) => a.legacyUserId - b.legacyUserId);
  duplicates.sort((a, b) => a.phone.localeCompare(b.phone));

  return { unique, duplicates, unusable };
};

export default groupByNormalizedPhone;
