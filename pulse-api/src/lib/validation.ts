/**
 * Validation utilities for Zod schemas
 * Use these helpers instead of .parse() to get proper 400 responses
 */

import { z, ZodSchema, ZodError } from 'zod';
import { FastifyReply } from 'fastify';

/**
 * Parse with proper 400 error response
 * Returns parsed data or sends 400 and returns null
 */
export function parseOrBadRequest<T extends ZodSchema>(
  schema: T,
  data: unknown,
  reply: FastifyReply
): z.infer<T> | null {
  const result = schema.safeParse(data);
  
  if (!result.success) {
    reply.status(400).send({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: result.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    });
    return null;
  }
  
  return result.data;
}

/**
 * Common date regex for YYYY-MM-DD format
 */
export const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date string schema with proper format validation
 */
export const dateString = z.string().regex(dateRegex, 'Invalid date format, expected YYYY-MM-DD');
