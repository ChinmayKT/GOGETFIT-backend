/**
 * THE Weekly Update definition - the backend's mirror of the app's form
 * (lib/features/body_metrics/domain/body_metric.dart, Weekly Update mode).
 *
 * Nine measurements, all required, stored as numbers under their API names;
 * `appKey` is the app's id for the same field. min / max describe the usual
 * range only - no limit is enforced on Weekly Update (not decided yet).
 * Gender, age and height are NOT inputs: they are snapshotted from the
 * member's questionnaire / profile when the update is submitted.
 *
 * Media: three required photos and one optional video, stored by reference.
 */

export const WEEKLY_MEASUREMENTS = [
  { key: 'weightKg', appKey: 'weight', label: 'Weight', unit: 'kg', min: 30, max: 250 },
  { key: 'neckCm', appKey: 'neck', label: 'Neck', unit: 'cm', min: 25, max: 60 },
  { key: 'chestCm', appKey: 'chest', label: 'Chest', unit: 'cm', min: 60, max: 160 },
  { key: 'rightArmFlexedCm', appKey: 'rightArm', label: 'Right Arm (Flexed)', unit: 'cm', min: 15, max: 60 },
  { key: 'leftArmFlexedCm', appKey: 'leftArm', label: 'Left Arm (Flexed)', unit: 'cm', min: 15, max: 60 },
  { key: 'waistCm', appKey: 'waist', label: 'Waist', unit: 'cm', min: 50, max: 160 },
  { key: 'hipsCm', appKey: 'hips', label: 'Hips', unit: 'cm', min: 60, max: 170 },
  { key: 'rightThighCm', appKey: 'rightThigh', label: 'Right Thigh', unit: 'cm', min: 30, max: 90 },
  { key: 'leftThighCm', appKey: 'leftThigh', label: 'Left Thigh', unit: 'cm', min: 30, max: 90 },
];

export const WEEKLY_MEASUREMENT_KEYS = WEEKLY_MEASUREMENTS.map((m) => m.key);
export const WEEKLY_MEASUREMENT_BY_KEY = new Map(WEEKLY_MEASUREMENTS.map((m) => [m.key, m]));

/** Upload slot (the app's name) → where the reference is kept on the record. */
export const WEEKLY_MEDIA_FIELDS = { front: 'frontPhoto', side: 'sidePhoto', back: 'backPhoto', video: 'video' };
export const WEEKLY_MEDIA_SLOTS = Object.keys(WEEKLY_MEDIA_FIELDS);
export const WEEKLY_REQUIRED_PHOTO_SLOTS = ['front', 'side', 'back'];
export const WEEKLY_VIDEO_SLOT = 'video';

export default {
  WEEKLY_MEASUREMENTS,
  WEEKLY_MEASUREMENT_KEYS,
  WEEKLY_MEASUREMENT_BY_KEY,
  WEEKLY_MEDIA_FIELDS,
  WEEKLY_MEDIA_SLOTS,
  WEEKLY_REQUIRED_PHOTO_SLOTS,
  WEEKLY_VIDEO_SLOT,
};
