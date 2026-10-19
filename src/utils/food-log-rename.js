/**
 * A stored food log meal in its current shape: its foods under `foods`
 * (moved from `entries`, the name before the rename) and an `image` (null
 * when it has none). Never both arrays, never the foods twice: a meal that
 * already has foods keeps them and its stale `entries` are dropped. Returns
 * null when [meal] is already in shape.
 */
export const renamedMeal = (meal) => {
  const hasEntries = Object.hasOwn(meal, 'entries');
  if (!hasEntries && Object.hasOwn(meal, 'foods') && Object.hasOwn(meal, 'image')) return null;
  const { entries, ...rest } = meal;
  const foods = Array.isArray(meal.foods) && meal.foods.length ? meal.foods : (entries ?? meal.foods ?? []);
  return { ...rest, image: meal.image ?? null, foods };
};

export default renamedMeal;
