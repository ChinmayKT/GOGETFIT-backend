/**
 * Age is derived from date of birth; DOB is the source of truth.
 *
 * All comparisons use UTC calendar parts so a timezone offset can never shift
 * the stored DOB by a day. A Feb 29 birth date is treated as having "occurred"
 * on Mar 1 in non-leap years, which falls out of the month/day comparison.
 */
export const calculateAge = (dateOfBirth, currentDate = new Date()) => {
  if (!dateOfBirth) return null;

  const dob = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
  const now = currentDate instanceof Date ? currentDate : new Date(currentDate);

  if (Number.isNaN(dob.getTime()) || Number.isNaN(now.getTime())) return null;
  if (dob.getTime() > now.getTime()) return null;

  let age = now.getUTCFullYear() - dob.getUTCFullYear();

  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  const dayDelta = now.getUTCDate() - dob.getUTCDate();

  // Birthday has not happened yet this year.
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }

  return age < 0 ? null : age;
};

/**
 * Parses a calendar date ("YYYY-MM-DD") into a UTC-midnight Date so the stored
 * value represents the calendar day the user entered, in any timezone.
 */
export const parseDateOfBirth = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));

  // Rejects impossible calendar dates such as 2025-02-30, which Date rolls over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
};

export const isFutureDate = (date, currentDate = new Date()) =>
  date instanceof Date && date.getTime() > currentDate.getTime();
