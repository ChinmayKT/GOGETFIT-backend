/**
 * THE Body Metrics definition - the backend's mirror of the app's form.
 *
 * Every key, unit and range is copied from the Flutter definition
 * (lib/features/body_metrics/domain/body_metric.dart, `bodyMetrics`): three
 * personal metrics and eight body measurements, stored in the app's canonical
 * units - years, centimetres, kilograms. Nothing is invented here.
 *
 * Media: three required photos and one optional video, stored by reference.
 */

/** Bump when a measurement is added, removed or its unit changes. */
export const BODY_METRICS_SCHEMA_VERSION = 1;

export const BODY_MEASUREMENTS = [
  { key: 'age', label: 'Age', unit: 'years', min: 13, max: 80, integer: true },
  { key: 'height', label: 'Height', unit: 'cm', min: 120, max: 220 },
  { key: 'weight', label: 'Weight', unit: 'kg', min: 30, max: 250 },
  { key: 'neck', label: 'Neck', unit: 'cm', min: 25, max: 60 },
  { key: 'chest', label: 'Chest', unit: 'cm', min: 60, max: 160 },
  { key: 'rightArm', label: 'Right Arm', unit: 'cm', min: 15, max: 60 },
  { key: 'leftArm', label: 'Left Arm', unit: 'cm', min: 15, max: 60 },
  { key: 'waist', label: 'Waist', unit: 'cm', min: 50, max: 160 },
  { key: 'hips', label: 'Hips', unit: 'cm', min: 60, max: 170 },
  { key: 'rightThigh', label: 'Right Thigh', unit: 'cm', min: 30, max: 90 },
  { key: 'leftThigh', label: 'Left Thigh', unit: 'cm', min: 30, max: 90 },
];

export const BODY_MEASUREMENT_KEYS = BODY_MEASUREMENTS.map((m) => m.key);
export const BODY_MEASUREMENT_BY_KEY = new Map(BODY_MEASUREMENTS.map((m) => [m.key, m]));

/** The three photos a submission must carry. */
export const REQUIRED_PHOTO_SLOTS = ['front', 'side', 'back'];
/** The optional progress video. */
export const VIDEO_SLOT = 'video';
export const MEDIA_SLOTS = [...REQUIRED_PHOTO_SLOTS, VIDEO_SLOT];

export default {
  BODY_METRICS_SCHEMA_VERSION,
  BODY_MEASUREMENTS,
  BODY_MEASUREMENT_KEYS,
  BODY_MEASUREMENT_BY_KEY,
  REQUIRED_PHOTO_SLOTS,
  VIDEO_SLOT,
  MEDIA_SLOTS,
};
