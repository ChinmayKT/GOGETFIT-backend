import mongoose from 'mongoose';

import { LEGACY_SOURCE } from './user.model.js';

/**
 * Diet types the legacy Admin Portal offered in its dropdown (Views/Diet/Diet.cshtml).
 * These exact strings are what m_plan.diet_type holds, so they are the canonical
 * vocabulary here too - a migrated plan and a plan created today are the same
 * shape, with no translation table in between.
 *
 * The dropdown also had a literal "Select" placeholder that could be submitted,
 * and two legacy rows carry it. Those are migrated as-is (fidelity first) but
 * "Select" is deliberately absent here: it is not a diet type, so no new plan
 * may be created with it.
 */
export const DIET_TYPES = ['Veg.', 'Veg/Egg', 'Veg/NonVeg'];

/** Legacy r_plan_meal.unit values, as the old dropdown wrote them (lowercase). */
export const FOOD_UNITS = [
  'bowl',
  'cup',
  'glass',
  'grams',
  'ml',
  'piece',
  'scoop',
  'serving',
  'slice',
  'spoon',
];

/** The free-plan flow has exactly Meal 1 to Meal 5 - never breakfast/lunch/dinner. */
export const MEAL_IDS = [1, 2, 3, 4, 5];

export const PLAN_STATUSES = ['active', 'archived'];

/**
 * One pre-authored food row, from r_plan_meal. These are authored templates, not
 * generated content, so every figure is stored exactly as the legacy row held it.
 */
const planFoodSchema = new mongoose.Schema(
  {
    /**
     * r_plan_meal.food_id - that table's OWN auto-increment primary key.
     *
     * It is NOT m_food.food_id: the legacy insert never wrote a food reference,
     * only a name. Named after the row, not the food, so nothing here is ever
     * mistaken for a foreign key into the food collection.
     */
    legacyPlanMealId: { type: Number, default: null },
    foodName: { type: String, required: true, trim: true },
    /**
     * Legacy r_plan_meal.food_type, char(1). The old add/edit grid had no column
     * for it, so every one of the 12,139 legacy rows holds an empty string, which
     * is stored here as null rather than as "".
     */
    foodType: { type: String, default: null, trim: true },
    unit: { type: String, default: null, trim: true },
    /** Legacy qty was varchar; every value is numeric, some with decimals. */
    quantity: { type: Number, default: null },
    calories: { type: Number, default: null },
    fat: { type: Number, default: null },
    carbs: { type: Number, default: null },
    protein: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * A meal within the plan. Array order is the meal order, and the food array
 * order is the authored row order - the legacy read had no ORDER BY, so
 * r_plan_meal's primary key order is the order the admin saw and is preserved.
 */
const planMealSchema = new mongoose.Schema(
  {
    mealId: { type: Number, required: true, min: 1, max: 5 },
    foods: { type: [planFoodSchema], default: () => [] },
  },
  { _id: false },
);

/**
 * Historical MariaDB identity plus the legacy row's own audit columns.
 *
 * Absent for plans authored in the new portal - a legacy planId is never
 * invented, exactly as with User.legacy.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true, default: LEGACY_SOURCE },
    planId: { type: Number, required: true },
    /** m_plan.create_date / created_by, kept verbatim for audit trails. */
    createdAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  { _id: false },
);

const migrationSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    migratedAt: { type: Date, default: null },
    version: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * A reusable, pre-authored Free Diet Plan template: the new home of legacy
 * m_plan + r_plan_meal.
 *
 * Modelled as one document rather than two collections because a plan is only
 * ever read, written and validated as a whole - the legacy edit path itself
 * deleted every child row and re-inserted them in one go, so the meals have no
 * independent lifetime.
 *
 * Named FreeDietPlan, not Plan: workout plans, client plans and coach plans are
 * separate concepts that will need their own collections.
 */
const freeDietPlanSchema = new mongoose.Schema(
  {
    /** Legacy diet_type string. No enum: "Select" exists in the legacy data. */
    dietType: { type: String, required: true, trim: true },
    /**
     * The calorie band this template is authored for, from m_plan.range_from /
     * range_to (varchar in MariaDB, every value numeric).
     */
    range: {
      from: { type: Number, required: true },
      to: { type: Number, required: true },
    },
    meals: { type: [planMealSchema], default: () => [] },
    /**
     * Soft-delete state. The legacy Admin Portal had no delete at all, and a
     * template may be referenced by a user's generated plan later, so deleting
     * here archives instead of destroying. Only "active" plans are listed.
     */
    status: { type: String, enum: PLAN_STATUSES, default: 'active' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: () => ({}) },
    /** The authenticated administrator, never a value supplied by the browser. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);

/**
 * Migration identity: the same legacy plan can never be migrated twice. Partial
 * so that plans authored in the new portal, which carry no legacy metadata, are
 * unaffected.
 */
freeDietPlanSchema.index(
  { 'legacy.source': 1, 'legacy.planId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_planid',
    partialFilterExpression: { 'legacy.planId': { $exists: true, $type: 'number' } },
  },
);

/**
 * Query index for the portal's list (filter by diet type, ordered by band).
 *
 * Deliberately NOT unique: staging holds three exact duplicate
 * (diet_type, range_from, range_to) triples - plans 609/610, 458/459 and
 * 710/711 - so a unique index here would make the legacy data impossible to
 * migrate. Creating a duplicate is refused in the service instead, which is
 * also where the legacy IsPlanExist check lived.
 */
freeDietPlanSchema.index(
  { status: 1, dietType: 1, 'range.from': 1 },
  { name: 'freediet_status_diettype_rangefrom' },
);

export const FreeDietPlan = mongoose.model('FreeDietPlan', freeDietPlanSchema);
export default FreeDietPlan;
