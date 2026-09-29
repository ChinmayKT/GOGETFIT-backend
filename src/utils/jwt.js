import jwt from 'jsonwebtoken';

import env from '../config/env.js';
import { ERROR_CODES, unauthorized } from './errors.js';

/** The JWT subject is always the MongoDB _id - never a legacy user_id. */
export const signUserToken = (user) =>
  jwt.sign({ sub: String(user._id), type: 'user' }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });

export const verifyUserToken = (token) => {
  try {
    const payload = jwt.verify(token, env.jwt.secret);
    if (payload.type !== 'user') {
      throw unauthorized(ERROR_CODES.TOKEN_INVALID, 'Token is not a user token');
    }
    return payload;
  } catch (error) {
    if (error.isOperational) throw error;
    throw unauthorized(ERROR_CODES.TOKEN_INVALID, 'Invalid or expired token');
  }
};
