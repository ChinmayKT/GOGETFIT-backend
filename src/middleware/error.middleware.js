import mongoose from 'mongoose';

import env from '../config/env.js';
import logger from '../config/logger.js';
import { AppError, ERROR_CODES } from '../utils/errors.js';
import { PhoneNormalizationError } from '../utils/phone.js';

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
};

const translate = (error) => {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, details: error.details };
  }

  if (error instanceof PhoneNormalizationError) {
    return { statusCode: 400, code: ERROR_CODES.INVALID_PHONE, message: error.message };
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Validation failed',
      details: Object.keys(error.errors),
    };
  }

  // Duplicate key on the unique phone index.
  if (error?.code === 11000) {
    return {
      statusCode: 409,
      code: ERROR_CODES.PHONE_ALREADY_REGISTERED,
      message: 'That identity is already registered',
    };
  }

  // Malformed JSON body from express.json().
  if (error?.type === 'entity.parse.failed') {
    return { statusCode: 400, code: ERROR_CODES.VALIDATION_ERROR, message: 'Malformed JSON body' };
  }

  // Body larger than the configured upload limit, refused before buffering.
  if (error?.type === 'entity.too.large') {
    return {
      statusCode: 413,
      code: ERROR_CODES.FILE_TOO_LARGE,
      message: 'The uploaded file is too large',
    };
  }

  return { statusCode: 500, code: ERROR_CODES.INTERNAL_ERROR, message: 'Internal server error' };
};

// eslint-disable-next-line no-unused-vars -- Express identifies the handler by arity.
export const errorHandler = (error, req, res, next) => {
  const { statusCode, code, message, details } = translate(error);

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} failed`, error);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${statusCode} ${code}`);
  }

  const body = { success: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;
  // Stack traces are never exposed outside development.
  if (!env.isProduction && statusCode >= 500) body.error.stack = error.stack;

  res.status(statusCode).json(body);
};
