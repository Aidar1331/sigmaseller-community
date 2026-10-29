/**
 * WB API response validation utilities.
 *
 * - validateWbResponse: Parses data through Zod schema, logs errors
 * - detectFieldAbsence: Detects when a critical field becomes all-zero (possible WB API rename)
 */

import { type ZodSchema, type ZodError } from 'zod';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'wb-validation' });

export interface ValidationResult<T> {
  success: boolean;
  data: T | null;
  errors: ZodError | null;
}

/**
 * Validate a WB API response against a Zod schema.
 * Logs validation errors but does NOT throw — allows graceful degradation.
 *
 * @param schema - Zod schema to validate against
 * @param data - Raw API response data
 * @param context - Context for logging (e.g., API endpoint name)
 * @returns Validation result with parsed data or null
 */
export function validateWbResponse<T>(
  schema: ZodSchema<T>,
  data: unknown,
  context: string,
): ValidationResult<T> {
  const result = schema.safeParse(data);

  if (!result.success) {
    logger.error(
      {
        context,
        errorCount: result.error.issues.length,
        firstErrors: result.error.issues.slice(0, 5).map(i => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      },
      'WB API response validation failed',
    );

    return { success: false, data: null, errors: result.error };
  }

  return { success: true, data: result.data, errors: null };
}

/**
 * Detect when a critical field is all-zero/null/undefined across all rows.
 * This could indicate a WB API field rename.
 *
 * @param rows - Array of response rows
 * @param criticalFields - Field names to check
 * @param context - Context for logging (sync run ID, endpoint)
 * @returns Array of field names that are suspiciously absent
 */
export function detectFieldAbsence(
  rows: any[],
  criticalFields: readonly string[],
  context: string,
): string[] {
  if (!Array.isArray(rows) || rows.length < 10) return [];

  const absentFields: string[] = [];

  for (const field of criticalFields) {
    const allZeroOrMissing = rows.every(row => {
      const val = row?.[field];
      return val === undefined || val === null || val === 0 || val === '';
    });

    if (allZeroOrMissing) {
      absentFields.push(field);
      logger.warn(
        {
          field,
          context,
          rowCount: rows.length,
        },
        `Critical WB API field "${field}" is all-zero/missing — possible API field rename`,
      );
    }
  }

  return absentFields;
}
