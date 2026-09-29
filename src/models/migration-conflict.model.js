import mongoose from 'mongoose';

export const CONFLICT_TYPES = {
  DUPLICATE_LEGACY_PHONE: 'DUPLICATE_LEGACY_PHONE',
  INVALID_LEGACY_PHONE: 'INVALID_LEGACY_PHONE',
  MISSING_LEGACY_PHONE: 'MISSING_LEGACY_PHONE',
  // A legacy account's phone already belongs to a different MongoDB user.
  PHONE_COLLISION_WITH_EXISTING_USER: 'PHONE_COLLISION_WITH_EXISTING_USER',
};

export const CONFLICT_STATUS = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  APPLIED: 'applied',
};

export const RESOLUTION_STRATEGIES = {
  // Exactly one legacy account keeps the phone and becomes a Mongo user.
  KEEP_ONE: 'KEEP_ONE',
  // Each legacy account is migrated under an explicitly supplied phone number.
  REASSIGN_PHONES: 'REASSIGN_PHONES',
  // Every legacy account in the group is intentionally excluded from migration.
  EXCLUDE_ALL: 'EXCLUDE_ALL',
};

const resolutionSchema = new mongoose.Schema(
  {
    strategy: { type: String, enum: Object.values(RESOLUTION_STRATEGIES), required: true },
    // KEEP_ONE: the single legacy userId that keeps this phone.
    keepLegacyUserId: { type: Number, default: null },
    // REASSIGN_PHONES: explicit legacyUserId -> corrected phone decisions.
    phoneAssignments: {
      type: [
        new mongoose.Schema(
          {
            legacyUserId: { type: Number, required: true },
            phone: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    note: { type: String, default: null },
    decidedBy: { type: String, required: true },
    decidedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const migrationConflictSchema = new mongoose.Schema(
  {
    // The run that first observed this conflict, and the most recent one to
    // re-observe it. A conflict is one decision about one identity, so later
    // runs update these fields instead of creating another pending record.
    runId: { type: String, required: true },
    lastSeenRunId: { type: String, default: null },
    seenInRuns: { type: [String], default: [] },
    type: { type: String, enum: Object.values(CONFLICT_TYPES), required: true },
    phone: { type: String, default: null },
    legacyUserIds: { type: [Number], default: [] },
    // Read-only snapshot of the offending legacy rows, for whoever decides.
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: Object.values(CONFLICT_STATUS),
      default: CONFLICT_STATUS.PENDING,
    },
    resolution: { type: resolutionSchema, default: null },
  },
  { timestamps: true, versionKey: false },
);

// One conflict record per (type, phone), across every run: re-running the
// migration must not produce a second pending decision for the same identity.
migrationConflictSchema.index({ type: 1, phone: 1 }, { unique: true, name: 'uniq_type_phone' });
migrationConflictSchema.index({ status: 1, type: 1 }, { name: 'lookup_status' });

export const MigrationConflict = mongoose.model('MigrationConflict', migrationConflictSchema);
export default MigrationConflict;
