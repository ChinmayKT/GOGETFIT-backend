import FreeDietPlan from '../models/free-diet-plan.model.js';

/**
 * Matches a member to one of the pre-authored Free Diet Plan templates.
 *
 * This is a lookup, not a generator: nothing here invents food, scales a
 * quantity, optimises macros, substitutes an item, filters foods by preference
 * or recalculates a nutrition figure. Food preference is applied once, through
 * dietType, exactly as the legacy flow applied it.
 *
 * The result is a single ObjectId stored on the member as
 * `profile.freeDietPlanId`. The template itself is never copied onto the user.
 */

/**
 * The member's own food vocabulary mapped onto the legacy template vocabulary.
 *
 * The right-hand values are the only ones m_plan.diet_type ever held (verified
 * against staging: Veg. 266, Veg/NonVeg 261, Veg/Egg 248, plus 2 junk "Select"
 * rows). "NonVeg" and "VegEgg" exist only in dead legacy code and are not used.
 */
export const FOOD_TYPE_TO_DIET_TYPE = {
  vegetarian: 'Veg.',
  nonVegetarian: 'Veg/NonVeg',
  vegetarianPlusEgg: 'Veg/Egg',
  // The brief spells this one `vegetarianEgg`; both spellings resolve to the
  // same legacy diet type so a client on either vocabulary still matches.
  vegetarianEgg: 'Veg/Egg',
};

export const dietTypeForFoodType = (foodType) => FOOD_TYPE_TO_DIET_TYPE[foodType] ?? null;

/** Fitness-profile values the match cannot be made without. */
export const REQUIRED_FITNESS_FIELDS = ['foodType', 'goal', 'bmr', 'tdee'];

/**
 * The daily calorie target a template is looked up with.
 *
 * The legacy GoGetFit rule, unchanged - the templates were authored against
 * these numbers, so a different rule would silently move members onto different
 * plans. Fat loss, in this order, and the order matters:
 *
 *   1. tdee - bmr >= 800  -> tdee - 400
 *   2. tdee - 250 <= bmr  -> bmr + 50   (the legacy boundary was inclusive)
 *   3. otherwise          -> tdee - 250
 *
 * Muscle/weight gain -> tdee + 150. Maintenance -> tdee + 10.
 *
 * This lives in the backend because the backend now owns plan matching: the app
 * no longer decides which template it gets, so there is exactly one copy of the
 * rule and nothing for the two sides to disagree about.
 */
export const GOALS = {
  fatLoss: 'fatLoss',
  muscleGain: 'muscleGain',
  maintainPhysique: 'maintainPhysique',
};

export const targetCaloriesFor = ({ bmr, tdee, goal }) => {
  switch (goal) {
    case GOALS.fatLoss:
      if (tdee - bmr >= 800) return tdee - 400;
      if (tdee - 250 <= bmr) return bmr + 50;
      return tdee - 250;
    case GOALS.muscleGain:
      return tdee + 150;
    case GOALS.maintainPhysique:
      return tdee + 10;
    default:
      return null;
  }
};

/**
 * What the stored profile is missing before a match can be made. Returned as a
 * list rather than thrown, so the caller can answer with one clear state.
 */
export const missingMatchInputs = (user) => {
  const fitness = user?.profile?.fitnessProfile ?? {};
  const missing = [];

  for (const field of REQUIRED_FITNESS_FIELDS) {
    const value = fitness[field];
    if (value === null || value === undefined || value === '') {
      missing.push(`profile.fitnessProfile.${field}`);
    }
  }

  if (fitness.foodType && !dietTypeForFoodType(fitness.foodType)) {
    missing.push('profile.fitnessProfile.foodType (unrecognised value)');
  }
  if (fitness.goal && !Object.values(GOALS).includes(fitness.goal)) {
    missing.push('profile.fitnessProfile.goal (unrecognised value)');
  }

  return missing;
};

/**
 * The active template whose band contains [targetCalories] for this diet type -
 * the same condition the legacy SQL used:
 *
 *   WHERE diet_type = ? AND range_from <= ? AND range_to >= ?
 *
 * No nearest-range fallback, ever: the legacy data has real gaps (Veg/Egg has
 * nothing between 2601 and 2700) and a member must be told rather than handed
 * someone else's plan.
 *
 * The legacy data also contains three overlapping bands, and the legacy code
 * took whatever row MySQL returned first from an unordered SELECT. Verified
 * against staging, that is primary-key order, i.e. the lowest plan_id:
 * Veg/NonVeg @2605 -> [710, 711], Veg/Egg @2705 -> [458, 459]. So migrated
 * templates win by lowest legacy.planId, and templates authored in the portal
 * (which have no legacy id) are only considered when no migrated one matches.
 *
 * Two queries rather than one sort because Mongo orders a missing field BEFORE
 * any number, which would let a portal-authored template outrank every migrated
 * one - the opposite of the rule.
 */
export const findTemplate = async (dietType, targetCalories) => {
  const match = {
    status: 'active',
    dietType,
    'range.from': { $lte: targetCalories },
    'range.to': { $gte: targetCalories },
  };

  const migrated = await FreeDietPlan.findOne({
    ...match,
    'legacy.planId': { $exists: true, $type: 'number' },
  })
    .sort({ 'legacy.planId': 1, _id: 1 })
    .lean();

  if (migrated) return migrated;

  return FreeDietPlan.findOne({ ...match, 'legacy.planId': { $exists: false } })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
};

/**
 * Resolves the member's current plan from their stored fitness profile and
 * writes the pointer onto the user document.
 *
 * Returns the outcome rather than throwing: the profile save itself succeeded,
 * and "no template covers this band" is a state the client has to show, not a
 * failure of the save.
 *
 *   { status: 'matched',      planId, dietType, targetCalories }
 *   { status: 'not_found',    planId: null, dietType, targetCalories }
 *   { status: 'incomplete',   planId: null, missing: [...] }
 *
 * `user` is the Mongoose document, which this mutates and saves; a previous
 * pointer is replaced, never kept alongside the new one.
 */
export const matchAndAttachPlan = async (user) => {
  const missing = missingMatchInputs(user);
  if (missing.length > 0) {
    // An incomplete profile cannot keep pointing at a plan chosen from figures
    // it no longer has.
    const cleared = await clearPlan(user);
    return { status: 'incomplete', planId: null, missing, changed: cleared };
  }

  const fitness = user.profile.fitnessProfile;
  const dietType = dietTypeForFoodType(fitness.foodType);
  const targetCalories = targetCaloriesFor({
    bmr: fitness.bmr,
    tdee: fitness.tdee,
    goal: fitness.goal,
  });

  /**
   * Matched on the target rounded to whole kcal.
   *
   * The templates declare integer bands (…2781-2790, 2791-2800, 2801-2810…)
   * while the target is a float, because BMR and TDEE are: maintenance on a TDEE
   * of 2790.1875 gives 2800.1875, which sits between 2800 and 2801 and would
   * match nothing at all. Rounding the lookup key by at most half a kcal is what
   * closes that, and it is not a nearest-plan fallback: a target inside a real
   * gap - Veg/Egg has nothing between 2601 and 2700 - still matches nothing.
   *
   * The exact figure is what gets reported; only the comparison is rounded.
   */
  const lookupCalories = Math.round(targetCalories);
  const template = await findTemplate(dietType, lookupCalories);

  if (!template) {
    const cleared = await clearPlan(user);
    return {
      status: 'not_found',
      planId: null,
      dietType,
      targetCalories,
      lookupCalories,
      changed: cleared,
    };
  }

  const previous = user.profile.freeDietPlanId ?? null;
  const changed = String(previous ?? '') !== String(template._id);

  if (changed) {
    user.profile.freeDietPlanId = template._id;
    await user.save();
  }

  return {
    status: 'matched',
    planId: String(template._id),
    previousPlanId: previous ? String(previous) : null,
    dietType,
    targetCalories,
    lookupCalories,
    changed,
  };
};

/** Drops the pointer when the profile no longer matches anything. */
const clearPlan = async (user) => {
  if ((user.profile.freeDietPlanId ?? null) === null) return false;
  user.profile.freeDietPlanId = null;
  await user.save();
  return true;
};
