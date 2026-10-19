import mongoose from 'mongoose';

import FreeDietPlan from '../models/free-diet-plan.model.js';
import User from '../models/user.model.js';
import { ERROR_CODES, conflict, notFound } from '../utils/errors.js';
import { dietTypeForFoodType, missingMatchInputs, targetCaloriesFor } from './free-diet-plan-match.service.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sort keys the portal may request, mapped to real paths. An arbitrary client
 * string never reaches Mongo as a sort field.
 */
const SORTABLE = {
  updatedAt: 'updatedAt',
  createdAt: 'createdAt',
  dietType: 'dietType',
  rangeFrom: 'range.from',
  rangeTo: 'range.to',
  legacyPlanId: 'legacy.planId',
};

const countFoods = (meals = []) =>
  meals.reduce((sum, meal) => sum + (meal.foods?.length ?? 0), 0);

/**
 * Nutrition totals across every meal. Computed on read rather than stored: the
 * legacy "Total" button computed them in the browser and never persisted them,
 * so there is no stored figure to drift out of step with the food rows.
 */
const totals = (meals = []) => {
  const sum = { calories: 0, fat: 0, carbs: 0, protein: 0 };
  for (const meal of meals) {
    for (const food of meal.foods ?? []) {
      sum.calories += food.calories ?? 0;
      sum.fat += food.fat ?? 0;
      sum.carbs += food.carbs ?? 0;
      sum.protein += food.protein ?? 0;
    }
  }
  // Float(8,4) columns summed 12,000 times produce long binary tails; four
  // decimals is the precision the legacy column actually held.
  return {
    calories: Number(sum.calories.toFixed(4)),
    fat: Number(sum.fat.toFixed(4)),
    carbs: Number(sum.carbs.toFixed(4)),
    protein: Number(sum.protein.toFixed(4)),
  };
};

const toLegacy = (doc) =>
  doc.legacy?.planId != null
    ? {
        source: doc.legacy.source ?? null,
        planId: doc.legacy.planId,
        createdAt: doc.legacy.createdAt ? doc.legacy.createdAt.toISOString() : null,
        createdBy: doc.legacy.createdBy ?? null,
        updatedAt: doc.legacy.updatedAt ? doc.legacy.updatedAt.toISOString() : null,
        updatedBy: doc.legacy.updatedBy ?? null,
      }
    : null;

/**
 * Allow-listed row for the list screen. The legacy list showed diet type and the
 * two range columns only; food/meal counts and timestamps are added because the
 * new list already has columns for them and both are derivable from the stored
 * document - nothing is invented.
 */
export const toPlanRow = (doc) => ({
  id: String(doc._id),
  dietType: doc.dietType ?? null,
  range: { from: doc.range?.from ?? null, to: doc.range?.to ?? null },
  mealCount: doc.meals?.length ?? 0,
  foodCount: countFoods(doc.meals),
  status: doc.status ?? null,
  legacyPlanId: doc.legacy?.planId ?? null,
  createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
  updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
});

/** Full document for the edit screen. Allow-listed, like toAdminUser. */
export const toPlanDetail = (doc) => ({
  ...toPlanRow(doc),
  meals: (doc.meals ?? []).map((meal) => ({
    mealId: meal.mealId,
    foods: (meal.foods ?? []).map((food) => ({
      legacyPlanMealId: food.legacyPlanMealId ?? null,
      foodName: food.foodName ?? null,
      foodType: food.foodType ?? null,
      unit: food.unit ?? null,
      quantity: food.quantity ?? null,
      calories: food.calories ?? null,
      fat: food.fat ?? null,
      carbs: food.carbs ?? null,
      protein: food.protein ?? null,
    })),
  })),
  totals: totals(doc.meals),
  legacy: toLegacy(doc),
  migration: doc.migration?.runId
    ? {
        runId: doc.migration.runId,
        migratedAt: doc.migration.migratedAt ? doc.migration.migratedAt.toISOString() : null,
        version: doc.migration.version ?? null,
      }
    : null,
});

/**
 * The member-facing shape: what the app's Free Diet Plan screen needs and
 * nothing else.
 *
 * Built as its own allow-list rather than by deleting fields from the admin
 * shape, so an administrative field added later is invisible here until someone
 * deliberately exposes it. No status, no legacy metadata, no migration stamp and
 * no audit trail.
 */
export const toMemberPlan = (doc) => ({
  id: String(doc._id),
  dietType: doc.dietType ?? null,
  range: { from: doc.range?.from ?? null, to: doc.range?.to ?? null },
  meals: (doc.meals ?? []).map((meal) => ({
    mealId: meal.mealId,
    foods: (meal.foods ?? []).map((food) => ({
      foodName: food.foodName ?? null,
      unit: food.unit ?? null,
      quantity: food.quantity ?? null,
      calories: food.calories ?? null,
      fat: food.fat ?? null,
      carbs: food.carbs ?? null,
      protein: food.protein ?? null,
    })),
  })),
  totals: totals(doc.meals),
});

/** Readable names for the match inputs missingMatchInputs reports. */
const MATCH_INPUT_LABELS = {
  'profile.fitnessProfile.foodType': 'Food type',
  'profile.fitnessProfile.goal': 'Goal',
  'profile.fitnessProfile.bmr': 'BMR',
  'profile.fitnessProfile.tdee': 'TDEE',
  'profile.fitnessProfile.foodType (unrecognised value)': 'Food type (unrecognised value)',
  'profile.fitnessProfile.goal (unrecognised value)': 'Goal (unrecognised value)',
};

const FITNESS_FIELDS = ['height', 'weight', 'bodyFatPercentage', 'activityLevel', 'foodType', 'goal', 'bmr', 'tdee'];

/**
 * Admin read: the Free Diet Plan one member received, and the figures it was
 * chosen from. Read-only - unlike matchAndAttachPlan this never writes the
 * pointer; it reports what is stored.
 *
 * Everything comes from the existing flow, nothing is recalculated here:
 *   - BMR and TDEE are the stored profile values;
 *   - the target is the match service's own targetCaloriesFor, and the lookup
 *     figure is that target rounded, exactly as the match rounds it;
 *   - "range" is the assigned template's calorie band (range.from-range.to) -
 *     the band the target falls in when the match is made;
 *   - what is missing is the match service's own missingMatchInputs.
 *
 * status:
 *   no_fitness    - no fitness data at all
 *   incomplete    - a match input is missing or unrecognised (see `missing`)
 *   not_assigned  - complete profile, but no plan pointer (no template covers
 *                   the target for this diet type)
 *   plan_missing  - the pointer names a template that no longer exists
 *   assigned      - the plan the member received
 *
 * Two queries: the user, then the one template.
 */
export const getUserFreeDietPlanForAdmin = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');
  const user = await User.findById(userId).select('profile.name profile.fitnessProfile profile.freeDietPlanId').lean();
  if (!user) throw notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found');

  const stored = user.profile?.fitnessProfile ?? {};
  const fitness = Object.fromEntries(FITNESS_FIELDS.map((k) => [k, stored[k] ?? null]));
  const hasFitness = Object.values(fitness).some((v) => v !== null && v !== '');
  const missing = missingMatchInputs(user).map((field) => ({ field, label: MATCH_INPUT_LABELS[field] ?? field }));

  const dietType = dietTypeForFoodType(fitness.foodType);
  const targetCalories = missing.length === 0 ? targetCaloriesFor({ bmr: fitness.bmr, tdee: fitness.tdee, goal: fitness.goal }) : null;
  const match = {
    dietType,
    targetCalories: targetCalories ?? null,
    lookupCalories: targetCalories == null ? null : Math.round(targetCalories),
  };

  const planId = user.profile?.freeDietPlanId ?? null;
  const doc = planId ? await FreeDietPlan.findById(planId).lean() : null;
  const plan = doc ? toPlanDetail(doc) : null;

  let status;
  if (!hasFitness) status = 'no_fitness';
  else if (missing.length > 0) status = 'incomplete';
  else if (!planId) status = 'not_assigned';
  else if (!doc) status = 'plan_missing';
  else status = 'assigned';

  return {
    user: { id: String(user._id), name: user.profile?.name ?? null },
    status,
    fitness,
    missing,
    match,
    freeDietPlanId: planId ? String(planId) : null,
    freeDietPlan: plan,
    /**
     * Whether the stored plan is the one the profile matches today: same diet
     * type, and the lookup figure inside its band. False means the profile
     * changed after the plan was assigned (it is re-matched on the next save).
     */
    planMatchesProfile:
      plan && match.lookupCalories != null
        ? plan.dietType === dietType && plan.range.from <= match.lookupCalories && match.lookupCalories <= plan.range.to
        : null,
  };
};

/** One active template for the member who is pointing at it, or null. */
export const getPlanForMember = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await FreeDietPlan.findOne({ _id: id, status: 'active' }).lean();
  return doc ? toMemberPlan(doc) : null;
};

export const buildPlanFilter = ({ search, dietType, status } = {}) => {
  // Archived plans are hidden unless asked for by name: a deleted plan must not
  // reappear in the portal's default list.
  const filter = { status: status ?? 'active' };

  if (dietType) filter.dietType = dietType;

  const term = String(search ?? '').trim();
  if (term !== '') {
    const rx = new RegExp(escapeRegex(term), 'i');
    const asNumber = Number.parseInt(term, 10);
    filter.$or = [{ dietType: rx }];
    if (!Number.isNaN(asNumber)) {
      // Searching "1610" should find the band that contains it as well as the
      // band that starts or ends there.
      filter.$or.push(
        { 'range.from': asNumber },
        { 'range.to': asNumber },
        { 'range.from': { $lte: asNumber }, 'range.to': { $gte: asNumber } },
        { 'legacy.planId': asNumber },
      );
    }
  }

  return filter;
};

/** One page of plans. Always paginated and always capped. */
export const listPlans = async (params = {}) => {
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const requested = Number.parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);

  const sortField = SORTABLE[params.sortKey] ?? SORTABLE.updatedAt;
  const sortDir = params.sortDir === 'asc' ? 1 : -1;

  const filter = buildPlanFilter(params);

  const [docs, total] = await Promise.all([
    FreeDietPlan.find(filter)
      .sort({ [sortField]: sortDir, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    FreeDietPlan.countDocuments(filter),
  ]);

  return {
    rows: docs.map(toPlanRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

export const getPlanById = async (id) => {
  // A malformed id is "no such plan", not a 500 from a CastError.
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await FreeDietPlan.findById(id).lean();
  return doc ? toPlanDetail(doc) : null;
};

/**
 * The legacy IsPlanExist check, reproduced: the old portal refused to INSERT a
 * plan whose (diet_type, range_from, range_to) triple already existed and told
 * the admin "Same Plan parameters already exists".
 *
 * Kept as a create-time service rule rather than a unique index because the
 * migrated data contains three such duplicate triples already - an index would
 * reject the legacy rows outright. Edits are not checked, matching the legacy
 * behaviour, which only guarded the insert path.
 */
const assertNoDuplicateBand = async ({ dietType, range }) => {
  const clash = await FreeDietPlan.exists({
    dietType,
    'range.from': range.from,
    'range.to': range.to,
    status: 'active',
  });

  if (clash) {
    throw conflict(
      ERROR_CODES.PLAN_ALREADY_EXISTS,
      'A free diet plan with the same diet type and calorie range already exists',
    );
  }
};

export const createPlan = async (input, adminId) => {
  await assertNoDuplicateBand(input);

  // _id, audit fields and legacy metadata are all set here, never taken from
  // the request: the validator has already rejected them if a client sent them.
  const created = await FreeDietPlan.create({
    dietType: input.dietType,
    range: input.range,
    meals: input.meals,
    status: input.status ?? 'active',
    createdBy: adminId,
    updatedBy: adminId,
  });

  return toPlanDetail(created.toObject());
};

/**
 * Controlled update: only validated fields are $set, so legacy metadata, the
 * migration stamp and createdAt/createdBy survive an edit untouched. The
 * document is never replaced wholesale.
 */
export const updatePlan = async (id, patch, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const update = { updatedBy: adminId };
  if (patch.dietType !== undefined) update.dietType = patch.dietType;
  if (patch.range !== undefined) update.range = patch.range;
  if (patch.meals !== undefined) update.meals = patch.meals;
  if (patch.status !== undefined) {
    update.status = patch.status;
    // Re-activating clears the deletion stamp; archiving is handled by deletePlan.
    if (patch.status === 'active') {
      update.deletedAt = null;
      update.deletedBy = null;
    }
  }

  const doc = await FreeDietPlan.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true, runValidators: true },
  ).lean();

  return doc ? toPlanDetail(doc) : null;
};

/**
 * Soft delete.
 *
 * The legacy Admin Portal had no plan delete at all (DietController exposes only
 * list/add/edit; the delete UI is commented out and DeletePlanMeal only clears
 * child rows during an edit). So there is no legacy behaviour to preserve here,
 * and destroying a template that a user's generated plan may later reference
 * would destroy history. Archiving keeps the document and hides it from the list.
 */
export const deletePlan = async (id, adminId) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const doc = await FreeDietPlan.findByIdAndUpdate(
    id,
    { $set: { status: 'archived', deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId } },
    { new: true },
  ).lean();

  return doc ? toPlanDetail(doc) : null;
};
