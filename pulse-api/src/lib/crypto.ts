import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';
import log from './logger.js';

const logger = log.child({ module: 'crypto' });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;

/**
 * Derive a key from the master secret using scrypt
 * SECURITY: API_KEY_ENCRYPTION_SECRET is required - no fallback to API_KEY
 */
function deriveKey(salt: Buffer): Buffer {
  const secret = env.API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('API_KEY_ENCRYPTION_SECRET is required for encryption operations');
  }
  return scryptSync(secret, salt, 32);
}

/**
 * Encrypt a plaintext string
 * Returns: base64 encoded string (salt + iv + authTag + ciphertext)
 */
export function encrypt(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Combine: salt + iv + authTag + ciphertext
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypt an encrypted string
 * Input: base64 encoded string from encrypt()
 */
export function decrypt(encryptedBase64: string): string {
  const combined = Buffer.from(encryptedBase64, 'base64');

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Check if a string looks like it's already encrypted
 * (base64 with minimum length for salt + iv + authTag)
 */
export function isEncrypted(value: string): boolean {
  if (!value || value.length < 60) return false; // Min length for encrypted value
  
  // JWT tokens start with "eyJ" - not encrypted
  if (value.startsWith('eyJ')) return false;
  
  // Plaintext marker prefix
  if (value.startsWith('plain:')) return false;
  
  try {
    const decoded = Buffer.from(value, 'base64');
    // Minimum: salt(16) + iv(16) + authTag(16) + 1 byte ciphertext
    return decoded.length >= SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Stable SHA-256 hash of a plaintext API key. Used as a per-workspace
 * dedup key in marketplace_shops (migration 0123) — different rows in the
 * same workspace can't share the same token. The hash leaks no plaintext
 * (sha256 of a high-entropy WB token is computationally irreversible) and
 * doesn't depend on encryption salt/iv, so it stays stable across re-encrypts.
 */
export function apiKeyHash(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Safely decrypt - returns null if decryption fails
 * SECURITY: Never returns plaintext on failure - could leak sensitive data
 * 
 * For migration: if value doesn't look encrypted, returns it as-is
 * (but logs a warning so you can fix it)
 */
export function safeDecrypt(value: string): string | null {
  if (!value) return null;
  
  // Handle plaintext marker prefix
  if (value.startsWith('plain:')) {
    return value.slice(6);
  }
  
  // If it doesn't look encrypted, return as-is (legacy unencrypted values)
  // In production, this should be logged and fixed
  if (!isEncrypted(value)) {
    logger.warn('safeDecrypt called with unencrypted value - should be migrated');
    return value;
  }
  
  try {
    return decrypt(value);
  } catch (err) {
    // Decryption failed - return null, never plaintext
    logger.error({ err }, 'safeDecrypt failed');
    return null;
  }
}
