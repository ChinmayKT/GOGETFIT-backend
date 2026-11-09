/**
 * CORS for browser clients (the Admin Portal). The mobile app sends no Origin
 * header and is unaffected.
 *
 * Only origins on an explicit allowlist get CORS headers, and the allowlist is
 * matched exactly - never a wildcard - because responses allow credentials. A
 * request from any other origin simply receives no CORS headers, so the browser
 * refuses to hand the response to that page.
 */

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Authorization,Content-Type,Accept';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/** The Vite dev server (`npm run dev`) and preview server (`npm run preview`). */
export const LOCAL_ADMIN_PORTAL_ORIGINS = Object.freeze([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

/**
 * Parses CORS_ALLOWED_ORIGINS (comma-separated) into exact origins.
 * Rejects wildcards and anything that is not a bare scheme://host[:port].
 */
export const parseAllowedOrigins = (value) => {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes('*')) {
        throw new Error(`CORS_ALLOWED_ORIGINS must list exact origins; wildcard "${entry}" is not allowed.`);
      }
      let url;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`CORS_ALLOWED_ORIGINS contains an invalid origin: "${entry}".`);
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry.replace(/\/+$/, '')) {
        throw new Error(`CORS_ALLOWED_ORIGINS entries must be bare origins like http://host:port, got "${entry}".`);
      }
      return url.origin;
    });
};

/**
 * The trusted origins: everything in CORS_ALLOWED_ORIGINS, plus the local
 * Admin Portal dev/preview origins outside production.
 */
export const resolveAllowedOrigins = ({ configured, isProduction }) => [
  ...new Set([...(isProduction ? [] : LOCAL_ADMIN_PORTAL_ORIGINS), ...parseAllowedOrigins(configured)]),
];

export const createCorsMiddleware = (allowedOrigins) => {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();

    // Responses differ by Origin, so caches must key on it.
    res.vary('Origin');
    if (!allowed.has(origin)) return next();

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    const isPreflight = req.method === 'OPTIONS' && req.headers['access-control-request-method'];
    if (!isPreflight) return next();

    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
    return res.status(204).end();
  };
};
