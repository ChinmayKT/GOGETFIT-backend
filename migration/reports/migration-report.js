import fs from 'node:fs/promises';
import path from 'node:path';

import logger from '../../src/config/logger.js';

export const createReport = (runId, { dryRun, source, database }) => ({
  runId,
  dryRun,
  source,
  database,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  // Counts required by the migration report contract.
  counts: {
    legacyRows: 0,
    transformed: 0,
    duplicatePhoneUsers: 0,
    invalidPhone: 0,
    missingPhone: 0,
    admittedByResolution: 0,
    eligible: 0,
    alreadyMigrated: 0,
    phoneCollision: 0,
    wouldInsert: 0,
    wouldUpdate: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
  },
  extracted: 0,
  transformed: 0,
  migratable: 0,
  conflicts: { total: 0, byType: {}, created: 0, existing: 0, pending: 0 },
  validation: { invalid: [], duplicateWithinBatch: [] },
  load: null,
  notes: [],
});

export const finishReport = (report) => {
  report.finishedAt = new Date().toISOString();
  return report;
};

export const writeReport = async (report, directory) => {
  const reportsDirectory = directory || path.join(process.cwd(), 'migration', 'reports', 'runs');
  await fs.mkdir(reportsDirectory, { recursive: true });

  const file = path.join(reportsDirectory, `${report.runId}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');

  return file;
};

export const printSummary = (report) => {
  const counts = report.counts;

  const lines = [
    '',
    '──────────────── MIGRATION SUMMARY ────────────────',
    `run id            : ${report.runId}`,
    `mode              : ${report.dryRun ? 'DRY RUN (no MongoDB writes)' : 'APPLY'}`,
    `legacy source     : ${report.source}`,
    `legacy database   : ${report.database}`,
    '',
    `Legacy users      : ${counts.legacyRows}`,
    `Transformed       : ${counts.transformed}`,
    `Duplicate phone   : ${counts.duplicatePhoneUsers}`,
    `Invalid phone     : ${counts.invalidPhone}`,
    `Missing phone     : ${counts.missingPhone}`,
    `Admitted by       : ${counts.admittedByResolution}`,
    `  resolution`,
    `Eligible          : ${counts.eligible}`,
    `Already migrated  : ${counts.alreadyMigrated}`,
    `Phone collision   : ${counts.phoneCollision}`,
    '',
  ];

  if (report.dryRun) {
    lines.push(`Would insert      : ${counts.wouldInsert}`, `Would update      : ${counts.wouldUpdate}`);
  } else {
    lines.push(`Inserted          : ${counts.inserted}`, `Updated           : ${counts.wouldUpdate}`);
  }

  lines.push(
    `Skipped           : ${counts.skipped}`,
    `Errors            : ${counts.errors}`,
    '',
    `Conflicts total   : ${report.conflicts.total} ${JSON.stringify(report.conflicts.byType)}`,
    `  new this run    : ${report.conflicts.created}`,
    `  still pending   : ${report.conflicts.pending}`,
  );

  for (const note of report.notes) lines.push(`note : ${note}`);
  lines.push('───────────────────────────────────────────────────', '');

  logger.info(lines.join('\n'));
};

export default { createReport, finishReport, writeReport, printSummary };
