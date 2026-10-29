/**
 * Structured application errors.
 *
 * Each error class carries an HTTP status code so the global
 * Fastify error handler can map it automatically.
 */

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }

  /** Serialise for JSON response. */
  toJSON() {
    return {
      error: this.code,
      message: this.message,
    };
  }
}

// ── 400 ──

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
}

// ── 401 / 402 / 403 ──

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}

export class PaymentRequiredError extends AppError {
  readonly statusCode = 402;
  readonly code = 'PAYMENT_REQUIRED';
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

// ── 404 ──

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

// ── 409 ──

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';

  readonly meta?: Record<string, unknown>;

  constructor(message: string, meta?: Record<string, unknown>) {
    super(message);
    this.meta = meta;
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      ...this.meta,
    };
  }
}

// ── 413 ──

export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = 'PAYLOAD_TOO_LARGE';
}

// ── 429 ──

export class TooManyRequestsError extends AppError {
  readonly statusCode = 429;
  readonly code = 'TOO_MANY_REQUESTS';
}

// ── 500 ──

export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'INTERNAL_ERROR';
}
