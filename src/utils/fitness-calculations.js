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
 * A coach diet plan's targets, exactly as the app's Create Diet Plan computes
 * them (coach_workspace/domain/plan_inputs.dart DietPlanTargets.from, and
 * diet_plan_create.dart, which rounds every figure to 2 decimals):
 *   calories = TDEE - 500 / TDEE / TDEE + 500 for fatLoss / maintain / gain
 *              (profile/domain/generated_diet_plan.dart targetCaloriesForGoal)
 *   split    = high protein 40/40/20 for fatLoss, else moderate carb 30/50/20
 *              (macroSplitForGoal; protein/carb/fat %)
 *   grams    = calories * pct / 100 / 4 (protein, carbs), / 9 (fat)
 *              (calculators/domain/macros_classification.dart computeMacroGrams)
 * [goal] is a FITNESS_GOALS value; every input is required.
 */
export const DIET_PLAN_MACRO_SPLITS = {
  fatLoss: { protein: 40, carbs: 40, fat: 20 },
  muscleGain: { protein: 30, carbs: 50, fat: 20 },
  maintainPhysique: { protein: 30, carbs: 50, fat: 20 },
};
const CALORIE_DELTA = { fatLoss: -500, maintainPhysique: 0, muscleGain: 500 };

/** Two decimals, as the app stores plan figures. */
export const round2 = (value) => Math.round(value * 100) / 100;

export const computeDietPlanTargets = ({ gender, age, heightCm, weightKg, activityLevel, goal }) => {
  const bmr = computeBmr({ gender, weightKg, heightCm, age });
  const tdee = computeTdee({ bmr, activityLevel });
  const calories = tdee + CALORIE_DELTA[goal];
  const split = DIET_PLAN_MACRO_SPLITS[goal];
  return {
    bmr: round2(bmr),
    tdee: round2(tdee),
    targets: {
      dailyCalorieTarget: round2(calories),
      fat: round2((calories * split.fat) / 100 / 9),
      carbs: round2((calories * split.carbs) / 100 / 4),
      protein: round2((calories * split.protein) / 100 / 4),
    },
  };
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

export default { ACTIVITY_LEVELS, FOOD_TYPES, FITNESS_GOALS, computeBmr, computeTdee, computeBodyFatPercentage, deriveFitnessFigures, computeDietPlanTargets };
