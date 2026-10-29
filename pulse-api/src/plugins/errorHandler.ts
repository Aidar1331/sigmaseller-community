/**
 * Global Fastify error handler.
 * 
 * Normalizes all errors to a consistent JSON format:
 * { error: string, message: string, statusCode: number }
 * 
 * Handles:
 * - AppError subclasses (BadRequestError, NotFoundError, etc.)
 * - Zod validation errors
 * - Fastify validation errors
 * - Generic errors (500)
 */

import type { FastifyError, FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { WbJamRequiredError } from '../integrations/wb/wbClient.js';

interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
}

interface JamErrorResponse extends ErrorResponse {
  details: {
    jamUrl: string;
    hint: string;
  };
}

function formatZodError(err: ZodError): string {
  const issues = err.issues.map(issue => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return issues.join('; ');
}

/**
 * Build error response from any error type
 */
export function buildErrorResponse(error: Error | FastifyError, request?: FastifyRequest): ErrorResponse {
  const response: ErrorResponse = {
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  };

  // WB Jam subscription required (402)
  if (error instanceof WbJamRequiredError) {
    return {
      error: 'WB_JAM_REQUIRED',
      message: error.message,
      statusCode: 402,
      details: {
        jamUrl: error.jamUrl,
        hint: 'Для расширенных функций аналитики требуется подписка «Джем» на Wildberries',
      },
    };
  }
  // AppError subclasses (BadRequestError, NotFoundError, etc.)
  else if (error instanceof AppError) {
    response.error = error.code;
    response.message = error.message;
    response.statusCode = error.statusCode;
  }
  // Zod validation errors (check both instanceof and name for cross-module compat)
  else if (error instanceof ZodError || error.name === 'ZodError') {
    response.error = 'VALIDATION_ERROR';
    response.statusCode = 400;
    if (process.env.NODE_ENV !== 'production') {
      response.message = formatZodError(error as ZodError);
      response.details = (error as ZodError).issues;
    } else {
      // In production, don't leak internal field structure
      response.message = 'Некорректные входные данные';
    }
  }
  // Fastify validation errors (from schema validation)
  else if ('validation' in error && Array.isArray((error as any).validation)) {
    response.error = 'VALIDATION_ERROR';
    const validationErrors = (error as any).validation;
    response.message = validationErrors
      .map((v: any) => v.message || `${v.instancePath}: ${v.keyword}`)
      .join('; ');
    response.statusCode = 400;
  }
  // Fastify errors with statusCode
  else if ('statusCode' in error && typeof (error as FastifyError).statusCode === 'number') {
    const fastifyError = error as FastifyError;
    response.statusCode = fastifyError.statusCode ?? 500;
    response.message = fastifyError.message;
    
    // Map status codes to error codes
    switch (response.statusCode) {
      case 400:
        response.error = 'BAD_REQUEST';
        break;
      case 401:
        response.error = 'UNAUTHORIZED';
        break;
      case 402:
        response.error = 'PAYMENT_REQUIRED';
        break;
      case 403:
        response.error = 'FORBIDDEN';
        break;
      case 404:
        response.error = 'NOT_FOUND';
        break;
      case 409:
        response.error = 'CONFLICT';
        break;
      case 413:
        response.error = 'PAYLOAD_TOO_LARGE';
        break;
      case 429:
        response.error = 'TOO_MANY_REQUESTS';
        break;
      default:
        response.error = response.statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
    }
  }
  // Generic errors
  else {
    // In production, never expose raw error messages (may contain SQL, stack traces, etc.)
    if (process.env.NODE_ENV === 'production') {
      response.message = 'Внутренняя ошибка сервера';
    } else {
      response.message = error.message || 'Unknown error';
    }

    // Log unexpected errors (always log full details server-side)
    if (request) {
      request.log.error({
        err: error,
        request: {
          method: request.method,
          url: request.url,
          params: request.params,
          query: request.query,
        },
      }, 'Unhandled error');
    }
  }

  return response;
}

/**
 * The error handler function - can be used directly with app.setErrorHandler
 */
export function globalErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const response = buildErrorResponse(error, request);

  // Log client errors at info level, server errors at error level
  if (response.statusCode >= 500) {
    request.log.error({
      statusCode: response.statusCode,
      error: response.error,
      message: response.message,
    }, 'Server error');
  } else if (response.statusCode >= 400) {
    request.log.info({
      statusCode: response.statusCode,
      error: response.error,
      message: response.message,
    }, 'Client error');
  }

  return reply.status(response.statusCode).send(response);
}

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    error: 'NOT_FOUND',
    message: `Route ${request.method} ${request.url} not found`,
    statusCode: 404,
  });
}

/**
 * Fastify plugin that registers the global error handler
 */
export const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler(globalErrorHandler);
  app.setNotFoundHandler(notFoundHandler);
};

// Wrap with fastify-plugin so setErrorHandler/setNotFoundHandler apply globally
// instead of being trapped in this plugin's encapsulated child scope. Without
// this wrap, ZodError thrown from any route handler escapes our handler and
// gets serialized by Fastify's default error handler as HTTP 500 — see audit
// 2026-05-14 §15.2.
export default fp(errorHandlerPlugin, { name: 'error-handler' });
