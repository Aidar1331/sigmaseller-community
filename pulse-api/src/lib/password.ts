/**
 * Password hashing using Node.js built-in scrypt (no external dependencies).
 *
 * Format: `scrypt:N:r:p:keyLen$salt$hash` (all hex-encoded)
 */

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelization
const KEY_LEN = 64; // derived key length

function scryptAsync(
  password: string,
  salt: string,
  keyLen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${KEY_LEN}$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [params, salt, keyHex] = hash.split('$');
  if (!params || !salt || !keyHex) return false;

  const parts = params.split(':');
  // parts: ['scrypt', N, r, p, keyLen]
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keyLen = Number(parts[4]);

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keyLen)) {
    return false;
  }

  const derived = await scryptAsync(password, salt, keyLen, { N, r, p });
  const storedKey = Buffer.from(keyHex, 'hex');

  if (derived.length !== storedKey.length) return false;
  return timingSafeEqual(derived, storedKey);
}
