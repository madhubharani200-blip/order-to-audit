export class AppError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(409, code, message);
  }
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  if (err?.message?.startsWith('Insufficient stock')) {
    return res.status(409).json({
      error: 'INSUFFICIENT_STOCK',
      message: err.message,
    });
  }

  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({
      error: 'DUPLICATE_RECORD',
      message: err.message,
    });
  }

  if (
    err?.code?.startsWith('SQLITE_CONSTRAINT') ||
    err?.message?.startsWith('Invalid ') ||
    err?.message?.includes('must be') ||
    err?.message?.includes('not found')
  ) {
    return res.status(400).json({
      error: 'BAD_REQUEST',
      message: err.message,
    });
  }

  return res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: err?.message || 'Unexpected error',
  });
}
