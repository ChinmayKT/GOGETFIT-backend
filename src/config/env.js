import 'dotenv/config';

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: int(process.env.PORT, 3000),

  mongoUri: process.env.MONGODB_URI,

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  },

  otp: {
    hashSecret: process.env.OTP_HASH_SECRET,
    ttlSeconds: int(process.env.OTP_TTL_SECONDS, 300),
    maxAttempts: int(process.env.OTP_MAX_ATTEMPTS, 5),
    debug: bool(process.env.OTP_DEBUG, false),
  },

  // The calendar day coupons (and other date-only rules) are judged in.
  businessTimezone: process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata',

  storage: {
    // Only the local-filesystem driver exists; see src/services/storage.
    driver: process.env.STORAGE_DRIVER || 'local',
    localRoot: process.env.STORAGE_LOCAL_ROOT || 'uploads',
    publicPath: process.env.STORAGE_PUBLIC_PATH || '/uploads',
    // Absolute base the app prefixes onto stored file URLs. On the Android
    // emulator the host is reachable at 10.0.2.2, so this is configurable.
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL || 'http://10.0.2.2:3000',
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
    // Workout videos are far larger than an avatar; the legacy files run to 7 MB.
    maxVideoUploadBytes: int(process.env.MAX_VIDEO_UPLOAD_BYTES, 50 * 1024 * 1024),
  },

  // Business switch from spec section 12: migration-only vs. open registration.
  allowNewRegistrations: bool(process.env.ALLOW_NEW_REGISTRATIONS, true),

  phone: {
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
    nationalNumberLength: int(process.env.NATIONAL_NUMBER_LENGTH, 10),
  },

  /**
   * Admin Portal password login. Separate from the mobile phone+OTP flow:
   * ordinary members have no password and cannot use this path.
   */
  adminAuth: {
    /**
     * Consecutive failed attempts before the account itself is locked. This is
     * per-account and survives a restart (it lives on the user document),
     * unlike the request rate limiter which is per-process.
     */
    maxFailedAttempts: int(process.env.ADMIN_MAX_FAILED_ATTEMPTS, 5),
    lockoutMinutes: int(process.env.ADMIN_LOCKOUT_MINUTES, 15),
    /** Request-level throttle on the login endpoint. */
    rateLimit: {
      limit: int(process.env.ADMIN_LOGIN_RATE_LIMIT, 10),
      windowMs: int(process.env.ADMIN_LOGIN_RATE_WINDOW_SECONDS, 300) * 1000,
    },
    /**
     * Required by the provisioning script before it will grant the admin role
     * or set a password. Read only by that script - the API never uses it, so a
     * running server cannot be talked into provisioning anyone.
     */
    bootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET || null,
  },
};

// Runtime secrets required by the API process. Migration-only variables are
// validated separately so the API never needs MariaDB credentials.
export const assertRuntimeEnv = () => {
  const missing = [];
  if (!env.mongoUri) missing.push('MONGODB_URI');
  if (!env.jwt.secret) missing.push('JWT_SECRET');
  if (!env.otp.hashSecret) missing.push('OTP_HASH_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Set them in your .env file.`,
    );
  }

  if (env.isProduction && env.otp.debug) {
    throw new Error('OTP_DEBUG must never be enabled in production.');
  }
};

export default env;
