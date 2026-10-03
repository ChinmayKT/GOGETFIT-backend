import mongoose from 'mongoose';

/**
 * The Food master: one document per food at one portion, which is what the
 * Add Food form captures and what a diet plan or a food log refers to.
 *
 * The same food at a different portion is a different document - "Paneer, 100
 * Grams" and "Paneer, 1 Bowl" are two foods, exactly as they were in legacy.
 * Nothing here is normalised to 100g: the nutrition belongs to `serving`, and
 * reading it any other way changes its meaning.
 *
 * Migrated foods (see docs/foods-legacy.md) carry nothing of the legacy system
 * except `legacy.foodId`. Everything else - audit columns, delete flags, the
 * abandoned m_food nutrition columns - is deliberately left behind, so a
 * migrated food and one added through the form are the same kind of document.
 */

/** The two values the Add Food form offers. Legacy "Veg." / "NonVeg" map onto these. */
export const FOOD_TYPES = ['Vegetarian', 'Non-Vegetarian'];

/**
 * The portion units the Add Food form offers, in its order. A unit is a
 * meaning, not a quantity: Grams stays Grams, ML stays ML, and nothing is ever
 * converted from one into another.
 */
export const FOOD_UNITS = [
  'Bowl',
  'Cup',
  'Glass',
  'Grams',
  'ML',
  'Piece',
  'Scoop',
  'Serving',
  'Slice',
  'Spoon',
];

/** active = listed; archived = hidden from the default list but still referenced. */
export const FOOD_STATUSES = ['active', 'archived'];

/**
 * Matches text against the unit vocabulary ignoring case and surrounding space,
 * and returns the canonical spelling - or null when there is no exact match.
 *
 * This resolves case only ("grams" -> "Grams"): the word must already be one of
 * the supported units. Anything else is reported by the caller, never guessed at.
 */
export const canonicalFoodUnit = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  return FOOD_UNITS.find((unit) => unit.toLowerCase() === text.toLowerCase()) ?? null;
};

/** A stored image: where it is served from and the storage driver's key for it. */
const imageRefSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

/**
 * The portion this food's nutrition describes: "100 Grams", "1 Bowl", "2 Piece".
 * Both parts are required - nutrition without a portion cannot be interpreted.
 */
const servingSchema = new mongoose.Schema(
  {
    unit: { type: String, enum: FOOD_UNITS, required: true },
    /** Legacy stored this as text; here it is a number, and 0 is allowed as legacy had it. */
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/**
 * The macros for one `serving`, exactly as entered. Required so that a food can
 * never exist without nutrition - the defect that made 11 legacy foods
 * invisible to every screen.
 */
const nutritionSchema = new mongoose.Schema(
  {
    calories: { type: Number, required: true, min: 0 },
    fat: { type: Number, required: true, min: 0 },
    carbs: { type: Number, required: true, min: 0 },
    protein: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/**
 * The only legacy information a migrated food keeps: which system it came from
 * and its id there. It exists for traceability and for migration identity, and
 * is absent from foods created in the portal - never invented.
 */
const legacySchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    foodId: { type: Number, required: true },
  },
  { _id: false },
);

/** Which migration run wrote a migrated food. Absent on foods added in the portal. */
const migrationSchema = new mongoose.Schema(
  {
    runId: { type: String, default: null },
    migratedAt: { type: Date, default: null },
    version: { type: Number, default: null },
  },
  { _id: false },
);

const foodSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    foodType: { type: String, enum: FOOD_TYPES, required: true },
    /** Optional, as in the form: a home-made food has no brand. */
    brand: { type: String, default: null, trim: true },

    serving: { type: servingSchema, required: true },
    nutrition: { type: nutritionSchema, required: true },

    /** The form's free-text "Comments". */
    notes: { type: String, default: null, trim: true },

    /**
     * The food's picture, or null. Set only through the food image endpoints,
     * which store the bytes; a filename on its own is never enough to claim an
     * image exists, so migrated foods start with none.
     */
    image: { type: imageRefSchema, default: null },

    /**
     * Archive-not-delete: diet plans and food logs reference foods by id, so
     * removing one would break history. Archiving hides it from the default list.
     */
    status: { type: String, enum: FOOD_STATUSES, default: 'active' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    legacy: { type: legacySchema, default: undefined },
    migration: { type: migrationSchema, default: () => ({}) },

    /** Set for foods created through the API; migrated foods carry null. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'foods' },
);

/**
 * Migration identity: re-running the migration finds the same document instead
 * of adding a second one. Partial, so foods created in the portal (which have
 * no legacy block) are unaffected.
 *
 * Note what is NOT unique: the name. Legacy legitimately holds the same food
 * several times with a different brand, unit or quantity, and each one is its
 * own food.
 */
foodSchema.index(
  { 'legacy.source': 1, 'legacy.foodId': 1 },
  {
    unique: true,
    name: 'uniq_legacy_source_foodid',
    partialFilterExpression: { 'legacy.foodId': { $exists: true, $type: 'number' } },
  },
);

/** The default list: active foods by name. */
foodSchema.index({ status: 1, name: 1 }, { name: 'food_status_name' });
/** Name search, and the duplicate-name reporting the admin list needs. */
foodSchema.index({ name: 1 }, { name: 'food_name' });

export const Food = mongoose.model('Food', foodSchema);
export default Food;
