/**
 * Common imports and helpers for schema files
 */

import {
  pgTable,
  text,
  bigint,
  boolean,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  real,
  date,
  serial,
  varchar,
  numeric,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Re-export for use in schema files
export {
  pgTable,
  text,
  bigint,
  boolean,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  real,
  date,
  serial,
  varchar,
  numeric,
  doublePrecision,
  sql,
};

// Common timestamp helper
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
