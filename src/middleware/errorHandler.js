import { createLogger } from '../utils/logger.js';

const logger = createLogger('errorHandler');

/**
 * Custom error classes for different error types
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, 400, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service = 'Service') {
    super(`${service} temporarily unavailable`, 503);
  }
}

/**
 * Global error handler middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export function errorHandler(err, req, res, next) {
  let error = { ...err };
  error.message = err.message;

  // Log error
  logError(error, req);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = new NotFoundError(message);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `${field} already exists`;
    error = new ValidationError(message, { field });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    let message = 'Validation failed';
    let errors = {};
    
    if (err.errors && typeof err.errors === 'object') {
      const messages = Object.values(err.errors).map(val => val.message);
      message = `Validation failed: ${messages.join(', ')}`;
      errors = err.errors;
    }
    
    error = new ValidationError(message, { errors });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = new AuthenticationError(message);
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = new AuthenticationError(message);
  }

  // Default to 500 server error
  const statusCode = error.statusCode || 500;
  const response = {
    error: {
      message: error.message,
      code: error.code,
      ...(process.env.NODE_ENV === 'development' && {
        stack: error.stack,
        details: error.details
      })
    }
  };

  // Don't expose internal errors in production
  if (statusCode === 500 && process.env.NODE_ENV === 'production') {
    response.error.message = 'Internal server error';
  }

  res.status(statusCode).json(response);
}

/**
 * Async error handler wrapper
 * @param {Function} fn - Async function to wrap
 * @returns {Function} - Wrapped function
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Log error with context
 * @param {Error} error - Error object
 * @param {Object} req - Express request
 */
function logError(error, req) {
  const logContext = {
    name: error.name,
    statusCode: error.statusCode,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id
  };

  if (error.statusCode >= 500) {
    // Server errors
    logger.error('Server Error', {
      ...logContext,
      message: error.message,
      stack: error.stack,
      details: error.details
    });
  } else if (error.statusCode >= 400) {
    // Client errors
    logger.warn('Client Error', {
      ...logContext,
      message: error.message,
      details: error.details
    });
  } else {
    // Other errors
    logger.info('Application Error', {
      ...logContext,
      message: error.message
    });
  }
}

/**
 * 404 handler middleware
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export function notFoundHandler(req, res, next) {
  const error = new NotFoundError(`Route ${req.originalUrl} not found`);
  next(error);
}

/**
 * Validate request body against Joi schema
 * @param {Object} schema - Joi schema
 * @returns {Function} - Express middleware
 */
export function validateRequest(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      allowUnknown: true,
      stripUnknown: true
    });

    if (error) {
      const details = error.details.reduce((acc, detail) => {
        acc[detail.path.join('.')] = detail.message;
        return acc;
      }, {});

      return next(new ValidationError('Invalid request data', details));
    }

    req.body = value;
    next();
  };
}

/**
 * Validate request parameters
 * @param {Object} schema - Joi schema for params
 * @returns {Function} - Express middleware
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params, {
      abortEarly: false
    });

    if (error) {
      const details = error.details.reduce((acc, detail) => {
        acc[detail.path.join('.')] = detail.message;
        return acc;
      }, {});

      return next(new ValidationError('Invalid parameters', details));
    }

    req.params = value;
    next();
  };
}

/**
 * Validate request query
 * @param {Object} schema - Joi schema for query
 * @returns {Function} - Express middleware
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      convert: true
    });

    if (error) {
      const details = error.details.reduce((acc, detail) => {
        acc[detail.path.join('.')] = detail.message;
        return acc;
      }, {});

      return next(new ValidationError('Invalid query parameters', details));
    }

    req.query = value;
    next();
  };
}

export default {
  errorHandler,
  asyncHandler,
  notFoundHandler,
  validateRequest,
  validateParams,
  validateQuery,
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError
};