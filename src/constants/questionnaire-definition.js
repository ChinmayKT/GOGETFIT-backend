/**
 * THE questionnaire definition - the backend's mirror of the app's fill flow.
 *
 * Every key, wording, answer type, option list and required flag here is copied
 * from the Flutter questionnaire as it exists today:
 *
 *   lib/features/questionnaire/presentation/screens/questionnaire_flow_page/
 *     questionnaire_flow_page.dart   (steps, options, wheel ranges, limits)
 *   lib/features/questionnaire/domain/questionnaire_question.dart
 *     (`kQuestionnaireQuestions` - key, step, type, female-only)
 *
 * 38 questions in five steps; 36 are asked of a male member, 38 of a female.
 * Nothing is invented here: a rule that is not in the app's flow is not a rule.
 *
 * This file is the validation contract, NOT something a questionnaire document
 * copies. A stored questionnaire keeps only `answers` plus the `schemaVersion`
 * that says which definition those answers were given against, so changing a
 * question's wording later never rewrites what a member actually answered.
 */

/** Bump when a question is added, removed, retyped, or its options change. */
export const QUESTIONNAIRE_SCHEMA_VERSION = 1;

export const QUESTIONNAIRE_STEPS = ['basics', 'nutrition', 'fitness', 'health', 'goals'];

export const QUESTION_TYPES = {
  SINGLE_CHOICE: 'singleChoice',
  WHEEL: 'wheel',
  SLIDER: 'slider',
  SHORT_TEXT: 'shortText',
  LONG_TEXT: 'longText',
};

/**
 * The wheel value lists, generated exactly as the app generates them, so the
 * accepted set is identical rather than merely similar. All three are stored as
 * STRINGS because the wheels store the label the member scrolled to.
 *
 * Height is decimal FEET (`5.7`), not centimetres - the app shows cm only as a
 * sub-label and never stores it.
 */
const ages = () => {
  const out = [];
  for (let a = 13; a <= 100; a += 1) out.push(String(a));
  return out;
};

const heightsFeet = () => {
  const out = [];
  for (let f = 40; f <= 80; f += 1) out.push((f / 10).toFixed(1));
  return out;
};

const weightsKg = () => {
  const out = [];
  for (let w = 40; w <= 600; w += 1) {
    const kg = w / 2;
    out.push(Number.isInteger(kg) ? String(kg) : kg.toFixed(1));
  }
  return out;
};

const SLIDER_MIN = 0;
const SLIDER_MAX = 10;

/**
 * One entry per question, in fill-flow order.
 *
 * `required` marks the keys the app's own step gate refuses to advance past
 * (`_mandatory` in questionnaire_flow_page.dart) - eight in total. Everything
 * else is optional in the app and therefore optional here.
 *
 * `femaleOnly` questions are not merely optional for a male member: the app
 * never renders them, so they are rejected unless the answered gender is
 * `Female`.
 *
 * `maxLength` is the app's character cap. Where the app sets none (city,
 * profession, highest weight, workout duration) none is enforced.
 */
export const QUESTIONNAIRE_QUESTIONS = [
  // --- 1. Basic Information ---------------------------------------------
  { key: 'gender', step: 'basics', label: 'Gender', type: QUESTION_TYPES.SINGLE_CHOICE, options: ['Male', 'Female'], required: true },
  { key: 'age', step: 'basics', label: 'Age (Years)', type: QUESTION_TYPES.WHEEL, options: ages(), required: true },
  { key: 'height', step: 'basics', label: 'Height (ft)', type: QUESTION_TYPES.WHEEL, options: heightsFeet(), required: true },
  { key: 'weight', step: 'basics', label: 'Weight (kg)', type: QUESTION_TYPES.WHEEL, options: weightsKg(), required: true },
  {
    key: 'goal',
    step: 'basics',
    label: 'Goal',
    type: QUESTION_TYPES.SINGLE_CHOICE,
    options: ['Fat / Weight Loss', 'Muscle / Weight Gain', 'Maintain Weight'],
    required: true,
  },
  { key: 'city', step: 'basics', label: 'City / Country', type: QUESTION_TYPES.SHORT_TEXT },
  { key: 'profession', step: 'basics', label: 'Profession', type: QUESTION_TYPES.SHORT_TEXT },
  { key: 'highestWeight', step: 'basics', label: 'Highest Recorded Weight', type: QUESTION_TYPES.SHORT_TEXT },
  {
    key: 'contactTime',
    step: 'basics',
    label: 'Best Time To Contact You',
    type: QUESTION_TYPES.SINGLE_CHOICE,
    options: ['Weekdays', 'Weekends', 'Anytime'],
    required: true,
  },

  // --- 2. Nutrition -------------------------------------------------------
  {
    key: 'foodPref',
    step: 'nutrition',
    label: 'Food Preference',
    type: QUESTION_TYPES.SINGLE_CHOICE,
    options: ['Vegetarian', 'Vegetarian + Egg', 'Vegetarian + Non-Veg', 'Non-Vegetarian'],
    required: true,
  },
  { key: 'triedDiet', step: 'nutrition', label: 'Have you tried dieting before?', type: QUESTION_TYPES.SINGLE_CHOICE, options: ['Yes', 'No'] },
  {
    key: 'dietDetails',
    step: 'nutrition',
    label: 'What kind of diet was that? How were the results?',
    type: QUESTION_TYPES.LONG_TEXT,
    maxLength: 500,
  },
  { key: 'foodRoutine', step: 'nutrition', label: 'Describe your current food routine.', type: QUESTION_TYPES.LONG_TEXT, maxLength: 500 },
  { key: 'foodsLike', step: 'nutrition', label: 'What foods do you like?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'foodsDislike', step: 'nutrition', label: 'What foods do you dislike?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'specialFood', step: 'nutrition', label: 'Any special food preferences?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'allergies', step: 'nutrition', label: 'Any food allergies?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },

  // --- 3. Fitness & Lifestyle --------------------------------------------
  {
    key: 'workoutPref',
    step: 'fitness',
    label: 'Workout Preference',
    type: QUESTION_TYPES.SINGLE_CHOICE,
    options: ['Home Workout', 'Gym Workout'],
    required: true,
  },
  { key: 'workoutDuration', step: 'fitness', label: 'How long have you been working out?', type: QUESTION_TYPES.SHORT_TEXT },
  { key: 'trainingLevel', step: 'fitness', label: 'Rate your current training level (0-10)', type: QUESTION_TYPES.SLIDER },
  { key: 'cardioLevel', step: 'fitness', label: 'Rate your current cardio level (0-10)', type: QUESTION_TYPES.SLIDER },
  { key: 'injuries', step: 'fitness', label: 'Any previous injuries?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  {
    key: 'dailyRoutine',
    step: 'fitness',
    label: 'What do you do throughout the day? Describe your daily routine.',
    type: QUESTION_TYPES.LONG_TEXT,
    maxLength: 500,
  },

  // --- 4. Health ----------------------------------------------------------
  { key: 'medications', step: 'health', label: 'Are you taking any medications?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'sickFreq', step: 'health', label: 'How often do you feel sick?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'coldFreq', step: 'health', label: 'How often do you catch a cold?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'digestiveFreq', step: 'health', label: 'How often do you have digestive issues?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'digestiveHealth', step: 'health', label: 'Rate your digestive health (0-10)', type: QUESTION_TYPES.SLIDER },
  {
    key: 'alcohol',
    step: 'health',
    label: 'Alcohol Consumption',
    type: QUESTION_TYPES.SINGLE_CHOICE,
    options: ['Never', 'Once a Week', 'Twice a Week', 'More Than Twice a Week'],
  },
  { key: 'smoke', step: 'health', label: 'Do you Smoke?', type: QUESTION_TYPES.SINGLE_CHOICE, options: ['Yes', 'No'] },
  {
    key: 'bodyShaming',
    step: 'health',
    label: 'Have you experienced body shaming?',
    type: QUESTION_TYPES.SINGLE_CHOICE,
    options: ['Yes', 'No', 'Maybe'],
  },

  // --- 5. Goals & Motivation ---------------------------------------------
  { key: 'periodCramps', step: 'goals', label: 'How severe are your period cramps?', type: QUESTION_TYPES.SLIDER, femaleOnly: true },
  { key: 'moodSwings', step: 'goals', label: 'How severe are your mood swings?', type: QUESTION_TYPES.SLIDER, femaleOnly: true },
  {
    key: 'cognitive',
    step: 'goals',
    label: 'Rate your cognitive skills (Thinking & Focus) (0-10)',
    type: QUESTION_TYPES.SLIDER,
  },
  { key: 'cravings', step: 'goals', label: 'How well do you control your cravings? (0-10)', type: QUESTION_TYPES.SLIDER },
  { key: 'whyTransform', step: 'goals', label: 'Why do you want to transform?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'longTermGoal', step: 'goals', label: 'What is your long-term goal?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
  { key: 'expectFromCoach', step: 'goals', label: 'What do you expect from your coach?', type: QUESTION_TYPES.SHORT_TEXT, maxLength: 200 },
];

export const QUESTION_BY_KEY = new Map(QUESTIONNAIRE_QUESTIONS.map((q) => [q.key, q]));

export const QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.map((q) => q.key);

/** The eight keys the app's own step gate will not advance past. */
export const REQUIRED_QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.filter((q) => q.required).map((q) => q.key);

export const FEMALE_ONLY_QUESTION_KEYS = QUESTIONNAIRE_QUESTIONS.filter((q) => q.femaleOnly).map((q) => q.key);

/** The gender answer that reveals the female-only questions, as the app spells it. */
export const FEMALE_GENDER = 'Female';

export const SLIDER_RANGE = { min: SLIDER_MIN, max: SLIDER_MAX };

export default {
  QUESTIONNAIRE_SCHEMA_VERSION,
  QUESTIONNAIRE_QUESTIONS,
  QUESTION_BY_KEY,
  QUESTION_KEYS,
  REQUIRED_QUESTION_KEYS,
  FEMALE_ONLY_QUESTION_KEYS,
  FEMALE_GENDER,
  SLIDER_RANGE,
};
