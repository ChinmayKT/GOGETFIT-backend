import {
  ambassadorSummary,
  getAmbassadorDetail,
  getMyAmbassador,
  getReferralDetail,
  listAmbassadorActivity,
  listAmbassadorPayouts,
  listAmbassadorReferralPlans,
  listAmbassadorReferrals,
  listAmbassadors,
  programPolicy,
  recordPayout,
  registerAmbassador,
  setAmbassadorCommission,
  setAmbassadorStatus,
} from '../services/brand-ambassador.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import {
  validateAmbassadorListQuery,
  validateCommission,
  validatePayout,
  validateReferralListQuery,
  validateRegister,
  validateStatusChange,
} from '../validators/brand-ambassador.validator.js';

const ambassadorNotFound = () => notFound(ERROR_CODES.AMBASSADOR_NOT_FOUND, 'Ambassador not found');
const referralNotFound = () => notFound(ERROR_CODES.AMBASSADOR_REFERRAL_NOT_FOUND, 'Referral not found');

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const pagination = (r) => ({ page: r.page, pageSize: r.pageSize, total: r.total, totalPages: r.totalPages });

// ─── member (the owner is always req.user) ───────────────────────────────────

/** GET /api/ambassadors/me - own profile (null before joining) and the programme terms. */
export const getMe = handle(async (req, res) => {
  const ambassador = await getMyAmbassador(req.user._id);
  res.status(200).json({ success: true, data: { ambassador, program: programPolicy() } });
});

/** POST /api/ambassadors/register - idempotent; 201 when created, 200 when already registered. */
export const postRegister = handle(async (req, res) => {
  validateRegister(req.body);
  const { ambassador, created } = await registerAmbassador(req.user._id);
  res.status(created ? 201 : 200).json({
    success: true,
    message: created ? 'Welcome to the Brand Ambassador programme' : 'Already registered',
    data: { ambassador, program: programPolicy(), created },
  });
});

// ─── admin ───────────────────────────────────────────────────────────────────

/** GET /api/admin/ambassadors */
export const getAdminAmbassadors = handle(async (req, res) => {
  const [result, summary] = await Promise.all([
    listAmbassadors(validateAmbassadorListQuery(req.query)),
    ambassadorSummary(),
  ]);
  res.status(200).json({ success: true, data: { ambassadors: result.rows, pagination: pagination(result), summary } });
});

/** GET /api/admin/ambassadors/:id */
export const getAdminAmbassador = handle(async (req, res) => {
  const ambassador = await getAmbassadorDetail(req.params.id);
  if (!ambassador) throw ambassadorNotFound();
  res.status(200).json({ success: true, data: { ambassador } });
});

/** PATCH /api/admin/ambassadors/:id/status */
export const patchAdminAmbassadorStatus = handle(async (req, res) => {
  const ambassador = await setAmbassadorStatus(req.params.id, validateStatusChange(req.body), req.user._id);
  if (!ambassador) throw ambassadorNotFound();
  res.status(200).json({ success: true, message: `Ambassador ${ambassador.status.toLowerCase()}`, data: { ambassador } });
});

/** PATCH /api/admin/ambassadors/:id/commission - future referrals only. */
export const patchAdminAmbassadorCommission = handle(async (req, res) => {
  const ambassador = await setAmbassadorCommission(req.params.id, validateCommission(req.body), req.user._id);
  if (!ambassador) throw ambassadorNotFound();
  res.status(200).json({ success: true, message: 'Commission rate updated', data: { ambassador } });
});

/** POST /api/admin/ambassadors/:id/payouts - records a payout made outside the system. */
export const postAdminAmbassadorPayout = handle(async (req, res) => {
  const payouts = await recordPayout(req.params.id, validatePayout(req.body), req.user._id);
  if (!payouts) throw ambassadorNotFound();
  res.status(200).json({ success: true, message: 'Payout recorded', data: { payouts } });
});

/** GET /api/admin/ambassadors/:id/referrals */
export const getAdminAmbassadorReferrals = handle(async (req, res) => {
  const query = validateReferralListQuery(req.query);
  const [result, plans] = await Promise.all([
    listAmbassadorReferrals(req.params.id, query),
    listAmbassadorReferralPlans(req.params.id),
  ]);
  if (!result) throw ambassadorNotFound();
  res.status(200).json({ success: true, data: { referrals: result.rows, pagination: pagination(result), plans } });
});

/** GET /api/admin/ambassadors/:id/payouts */
export const getAdminAmbassadorPayouts = handle(async (req, res) => {
  const payouts = await listAmbassadorPayouts(req.params.id);
  if (!payouts) throw ambassadorNotFound();
  res.status(200).json({ success: true, data: { payouts } });
});

/** GET /api/admin/ambassadors/:id/activity */
export const getAdminAmbassadorActivity = handle(async (req, res) => {
  const activity = await listAmbassadorActivity(req.params.id);
  if (!activity) throw ambassadorNotFound();
  res.status(200).json({ success: true, data: { activity } });
});

/** GET /api/admin/ambassador-referrals/:id */
export const getAdminReferral = handle(async (req, res) => {
  const referral = await getReferralDetail(req.params.id);
  if (!referral) throw referralNotFound();
  res.status(200).json({ success: true, data: { referral } });
});
