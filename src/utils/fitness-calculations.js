/**
 * The member profile's derived fitness figures - body fat %, BMR and TDEE.
 *
 * These are EXACT ports of the Flutter app's own functions, which the app uses
 * when a member saves their profile (and sends the results to
 * PATCH /users/me/profile):
 *
 *   GoGetFit 2.0/lib/features/calculators/domain/bmr_tdee_classification.dart
 *     computeBmr                - Mifflin-St Jeor
 *     computeTdee               - bmr * kActivityLevels[level].multiplier
 *     computeBodyFatPercentage  - Deurenberg, as the legacy calculateFat1()
 *   GoGetFit 2.0/lib/features/auth/presentation/providers/auth_controller.dart
 *     ageInYears                - whole years (backend: utils/age.js calculateAge)
 *
 * They exist here only so an admin-created user is calculated by the server
 * rather than trusted from the browser. Same constants, same inputs, same
 * order of operations - change them in both places or not at all. The parity
 * tests (tests/unit/fitness-calculations.test.js) pin results produced by the
 * Dart functions.
 */

/** The app's ActivityLevel enum names, in its order, with its multipliers. */
export const ACTIVITY_LEVELS = [
  { value: 'sedentary', label: 'Sedentary', multiplier: 1.2 },
  { value: 'light', label: 'Lightly Active', multiplier: 1.375 },
  { value: 'moderate', label: 'Moderately Active', multiplier: 1.55 },
  { value: 'active', label: 'Active', multiplier: 1.725 },
  { value: 'veryActive', label: 'Very Active', multiplier: 1.9 },
];

/** The app's FoodType enum names (profile_entities.dart). */
export const FOOD_TYPES = ['vegetarian', 'nonVegetarian', 'vegetarianPlusEgg'];

/** The app's FitnessGoal enum names (profile_entities.dart). */
export const FITNESS_GOALS = ['fatLoss', 'muscleGain', 'maintainPhysique'];

export const GENDERS = ['male', 'female'];

/** Mifflin-St Jeor equation - kcal/day at complete rest. */
export const computeBmr = ({ gender, weightKg, heightCm, age }) => {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return gender === 'male' ? base + 5 : base - 161;
};

/** Total Daily Energy Expenditure - BMR scaled by the activity multiplier. */
export const computeTdee = ({ bmr, activityLevel }) => {
  const info = ACTIVITY_LEVELS.find((a) => a.value === activityLevel);
  if (!info) throw new Error(`Unknown activity level: ${activityLevel}`);
  return bmr * info.multiplier;
};

/** Deurenberg: 1.20*BMI + 0.23*age - 16.2 (male) / - 5.4 (female). */
export const computeBodyFatPercentage = ({ gender, weightKg, heightCm, age }) => {
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  const genderConstant = gender === 'male' ? -16.2 : -5.4;
  return 1.2 * bmi + 0.23 * age + genderConstant;
};

/**
 * Everything the app would send for this profile. Each figure is null when an
 * input is missing, exactly as the app omits it.
 */
export const deriveFitnessFigures = ({ gender, age, heightCm, weightKg, activityLevel }) => {
  if (!GENDERS.includes(gender) || age === null || age === undefined || !heightCm || !weightKg) {
    return { bodyFatPercentage: null, bmr: null, tdee: null };
  }
  const bmr = computeBmr({ gender, weightKg, heightCm, age });
  return {
    bodyFatPercentage: computeBodyFatPercentage({ gender, weightKg, heightCm, age }),
    bmr,
    tdee: activityLevel ? computeTdee({ bmr, activityLevel }) : null,
  };
};

export default { ACTIVITY_LEVELS, FOOD_TYPES, FITNESS_GOALS, computeBmr, computeTdee, computeBodyFatPercentage, deriveFitnessFigures };
