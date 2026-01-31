/**
 * Centralized Error Handling Middleware
 *
 * Provides:
 * - Catch all errors
 * - Format error responses
 * - Log errors with context
 * - Don't leak internal details in production
 */

import { Request, Response, NextFunction } from 'express';
import { defaultLogger as logger } from '../utils/logger';
import { httpRequestErrors } from '../utils/metrics';

const NODE_ENV = process.env.NODE_ENV || 'development';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  code?: string;
  context?: Record<string, any>;
}

/**
 * Custom error classes
 */
export class BadRequestError extends Error implements AppError {
  statusCode = 400;
  isOperational = true;
  code = 'BAD_REQUEST';

  constructor(message: string, public context?: Record<string, any>) {
    super(message);
    this.name = 'BadRequestError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnauthorizedError extends Error implements AppError {
  statusCode = 401;
  isOperational = true;
  code = 'UNAUTHORIZED';

  constructor(message: string = 'Authentication required', public context?: Record<string, any>) {
    super(message);
    this.name = 'UnauthorizedError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ForbiddenError extends Error implements AppError {
  statusCode = 403;
  isOperational = true;
  code = 'FORBIDDEN';

  constructor(message: string = 'Access denied', public context?: Record<string, any>) {
    super(message);
    this.name = 'ForbiddenError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends Error implements AppError {
  statusCode = 404;
  isOperational = true;
  code = 'NOT_FOUND';

  constructor(message: string, public context?: Record<string, any>) {
    super(message);
    this.name = 'NotFoundError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConflictError extends Error implements AppError {
  statusCode = 409;
  isOperational = true;
  code = 'CONFLICT';

  constructor(message: string, public context?: Record<string, any>) {
    super(message);
    this.name = 'ConflictError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class RateLimitError extends Error implements AppError {
  statusCode = 429;
  isOperational = true;
  code = 'RATE_LIMIT_EXCEEDED';

  constructor(message: string = 'Rate limit exceeded', public context?: Record<string, any>) {
    super(message);
    this.name = 'RateLimitError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class InternalServerError extends Error implements AppError {
  statusCode = 500;
  isOperational = false;
  code = 'INTERNAL_SERVER_ERROR';

  constructor(message: string = 'Internal server error', public context?: Record<string, any>) {
    super(message);
    this.name = 'InternalServerError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ServiceUnavailableError extends Error implements AppError {
  statusCode = 503;
  isOperational = true;
  code = 'SERVICE_UNAVAILABLE';

  constructor(message: string, public context?: Record<string, any>) {
    super(message);
    this.name = 'ServiceUnavailableError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Format error response
 */
function formatErrorResponse(error: AppError, includeStack: boolean = false) {
  const response: any = {
    error: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      timestamp: new Date().toISOString(),
    },
  };

  // Include context in development
  if (includeStack && error.context) {
    response.error.context = error.context;
  }

  // Include stack trace in development
  if (includeStack && error.stack) {
    response.error.stack = error.stack;
  }

  return response;
}

/**
 * Error handling middleware
 */
export function errorHandler(err: AppError, req: Request, res: Response, next: NextFunction): void {
  // Extract request context
  const requestContext = {
    method: req.method,
    url: req.url,
    requestId: (req as any).requestId,
    userId: (req as any).user?.userId,
    organizationId: (req as any).user?.organizationId,
  };

  // Determine status code
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational ?? false;

  // Log error
  if (statusCode >= 500) {
    logger.error('Server error occurred', {
      error: err,
      stack: err.stack,
      ...requestContext,
    });
  } else if (statusCode >= 400) {
    logger.warn('Client error occurred', {
      errorMessage: err.message,
      code: err.code,
      ...requestContext,
    });
  }

  // Record metrics
  httpRequestErrors.inc({
    method: req.method,
    route: req.route?.path || req.path,
    error_type: err.code || err.name,
  });

  // Send response
  const includeStack = NODE_ENV !== 'production';
  const response = formatErrorResponse(err, includeStack);

  // Don't leak internal details in production
  if (NODE_ENV === 'production' && !isOperational) {
    response.error.message = 'An unexpected error occurred';
    delete response.error.context;
    delete response.error.stack;
  }

  res.status(statusCode).json(response);
}

/**
 * 404 handler
 */
export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route not found: ${req.method} ${req.path}`));
}

/**
 * Async error wrapper
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validation error handler
 */
export function handleValidationError(error: any): AppError {
  if (error.name === 'ValidationError') {
    return new BadRequestError('Validation failed', {
      details: error.details || error.errors,
    });
  }
  return error;
}

export default errorHandler;
