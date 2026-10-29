/**
 * Drizzle ORM re-exports
 * 
 * Import operators from here instead of 'drizzle-orm' directly:
 * 
 * Before:
 *   import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull } from 'drizzle-orm';
 * 
 * After:
 *   import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull } from '../lib/drizzle.js';
 * 
 * Benefits:
 * - Cleaner diffs (single import)
 * - Easy to add custom helpers
 * - Type augmentation in one place
 */

// Comparison operators
export { eq, ne, gt, gte, lt, lte } from 'drizzle-orm';

// Logical operators
export { and, or, not } from 'drizzle-orm';

// Array operators
export { inArray, notInArray } from 'drizzle-orm';

// Null checks
export { isNull, isNotNull } from 'drizzle-orm';

// String operators
export { like, ilike, notLike, notIlike } from 'drizzle-orm';

// Range operators
export { between, notBetween } from 'drizzle-orm';

// Ordering
export { asc, desc } from 'drizzle-orm';

// SQL template
export { sql } from 'drizzle-orm';

// Aggregates and functions (commonly used)
export { count, sum, avg, min, max } from 'drizzle-orm';

// Exists
export { exists, notExists } from 'drizzle-orm';

// Aliases
export { alias } from 'drizzle-orm/pg-core';
