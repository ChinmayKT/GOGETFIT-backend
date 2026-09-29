import { hasAnyRole } from '../constants/roles.js';
import { ERROR_CODES, forbidden, unauthorized } from '../utils/errors.js';
import { verifyUserToken } from '../utils/jwt.js';
import { findById } from '../services/user.service.js';

export const requireAuth = async (req, res, next) => {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw unauthorized(ERROR_CODES.UNAUTHORIZED, 'Bearer token required');
    }

    const payload = verifyUserToken(token);
    // The subject is a Mongo _id; legacy ids are never accepted here.
    const user = await findById(payload.sub);

    if (!user) {
      throw unauthorized(ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }
    if (user.status !== 'active') {
      throw unauthorized(ERROR_CODES.UNAUTHORIZED, 'Account is not active');
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Role gate. Must run AFTER requireAuth, which is what puts the MongoDB
 * document on req.user.
 *
 * The authority is that stored document - never a role supplied by the client
 * in a header, body, query string or JWT claim. The token carries only a
 * subject id for exactly this reason: roles revoked in the database take effect
 * on the very next request, without waiting for a token to expire.
 *
 * Returns 403 (authenticated, not permitted), distinct from requireAuth's 401.
 */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) {
      next(unauthorized(ERROR_CODES.UNAUTHORIZED, 'Authentication required'));
      return;
    }
    if (!hasAnyRole(req.user, roles)) {
      // Deliberately does not name the missing role or echo what the caller has.
      next(forbidden(ERROR_CODES.FORBIDDEN, 'Insufficient permissions'));
      return;
    }
    next();
  };
