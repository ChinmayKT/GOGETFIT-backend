import crypto from 'node:crypto';

import env from '../config/env.js';

/**
 * Thrown by a provider adapter when the provider definitely did NOT accept
 * the message (e.g. it rejected the number or the request). Nothing was
 * sent, so the request is not charged against the daily limit.
 */
export class OtpDeliveryRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OtpDeliveryRejectedError';
  }
}

/**
 * Development delivery: sends nothing and accepts at once (the code is only
 * visible through OTP_DEBUG's devOtp, as before).
 */
const logProvider = {
  name: 'log',
  send: async () => ({ messageId: `log-${crypto.randomUUID()}` }),
};

let override = null;

/** Tests (and Phase 3's WhatsApp adapter) plug a provider in here. */
export const setOtpDeliveryProvider = (provider) => {
  override = provider;
};

const currentProvider = () => {
  if (override) return override;
  if (env.otp.delivery === 'log') return logProvider;
  throw new Error(`Unknown OTP_DELIVERY "${env.otp.delivery}"`);
};

/**
 * Hands the code to the provider. Never throws; the outcome decides billing:
 *   accepted   - provider took it: charge the request, keep the code.
 *   rejected   - provider definitely refused (OtpDeliveryRejectedError): do
 *                not charge, discard the code.
 *   uncertain  - timeout or unexpected failure: it may still be delivered, so
 *                charge the request and keep the code valid (safe default:
 *                never a free retry that could double-send).
 */
export const deliverOtp = async ({ e164, code, expiresAt }) => {
  const provider = currentProvider();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'uncertain', reason: 'timeout' }), env.otp.deliveryTimeoutMs);
  });
  try {
    return await Promise.race([
      provider.send({ e164, code, expiresAt }).then((r) => ({
        status: 'accepted',
        messageId: r?.messageId ?? null,
        channel: provider.name,
      })),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof OtpDeliveryRejectedError) return { status: 'rejected', reason: error.message };
    return { status: 'uncertain', reason: error?.message ?? 'unknown' };
  } finally {
    clearTimeout(timer);
  }
};
