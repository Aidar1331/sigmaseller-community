/**
 * S3 Storage Service
 * Для хранения изображений Visual Studio.
 *
 * Если S3 credentials не настроены (dev / пока не подключили Yandex Cloud),
 * fallback на локальный диск: `pulse-api/storage/<path>` + URL через
 * `GET /storage/<path>` (зарегистрирован в server.ts как статика).
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import logger from './logger.js';

// S3 Client (lazy init)
let s3Client: S3Client | null = null;

function hasS3Credentials(): boolean {
  return Boolean(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_ENDPOINT);
}

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.S3_REGION || 'ru-central1',
      endpoint: env.S3_ENDPOINT,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true, // Required for Yandex Cloud / MinIO
    });
  }
  return s3Client;
}

const BUCKET = env.S3_BUCKET || 'pulse-studio';

// Локальное хранилище (dev-fallback). Абсолютный путь, т.к. tsx cwd может
// быть разный — привязываемся к корню pulse-api.
const LOCAL_STORAGE_ROOT = path.resolve(process.cwd(), 'storage');
const LOCAL_STORAGE_PUBLIC_BASE = env.LOCAL_STORAGE_URL || `http://localhost:${env.PORT || 3002}/storage`;

/**
 * Reject filePath that tries to escape the storage root via traversal segments
 * or absolute paths. We accept only relative paths under `storage/`.
 *
 * Without this guard a caller passing `../../etc/passwd` (or `/etc/passwd` on
 * the local-disk fallback) writes outside the bucket area. We block those and
 * any backslashes (Windows traversal).
 */
function assertSafeStorageKey(filePath: string): void {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('uploadFile: filePath required');
  }
  if (filePath.includes('..') || filePath.startsWith('/') || filePath.startsWith('\\') || filePath.includes('\0')) {
    throw new Error(`uploadFile: unsafe filePath "${filePath}"`);
  }
}

/**
 * Upload file to S3 (prod) or local disk (dev if no S3 credentials).
 *
 * Default ACL is `private` — uploaded objects are NOT directly accessible by
 * URL. Callers that need to expose the file should issue a `getSignedDownloadUrl`
 * with a short TTL. This prevents enumeration of studio creatives, KB documents
 * and AB photos via the bucket endpoint.
 */
export async function uploadFile(
  buffer: Buffer,
  filePath: string,
  contentType: string,
  opts: { acl?: 'private' | 'public-read' } = {}
): Promise<string> {
  assertSafeStorageKey(filePath);
  if (!hasS3Credentials()) {
    // DEV fallback — disk
    const absPath = path.join(LOCAL_STORAGE_ROOT, filePath);
    // Defense in depth: even after assertSafeStorageKey, verify the resolved
    // absolute path is still under LOCAL_STORAGE_ROOT before writing.
    const resolved = path.resolve(absPath);
    if (!resolved.startsWith(path.resolve(LOCAL_STORAGE_ROOT) + path.sep)) {
      throw new Error(`uploadFile: resolved path escapes storage root: ${filePath}`);
    }
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolved, buffer);
    const url = `${LOCAL_STORAGE_PUBLIC_BASE}/${filePath.replace(/\\/g, '/')}`;
    logger.info({ filePath, url, bytes: buffer.length }, 'uploadFile: stored locally (S3 not configured)');
    return url;
  }

  const client = getS3Client();
  // Default ACL is private. Callers serve via signed URLs — see getSignedDownloadUrl.
  // Do not switch back to public-read without explicit security review;
  // public-read enables enumeration of every uploaded file.
  const acl = opts.acl ?? 'private';
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: filePath,
    Body: buffer,
    ContentType: contentType,
    ACL: acl,
  }));
  // Return a presigned URL with 1-hour TTL when the object is private; callers
  // who hold this URL can render or download but cannot share it forever.
  if (acl === 'private') {
    return getSignedDownloadUrl(filePath, 3600);
  }
  const endpoint = env.S3_ENDPOINT?.replace('https://', '').replace('http://', '') || '';
  return `https://${BUCKET}.${endpoint}/${filePath}`;
}

/**
 * Get signed upload URL (for direct browser uploads)
 */
export async function getSignedUploadUrl(
  path: string,
  contentType: string,
  expiresIn: number = 3600
): Promise<string> {
  const client = getS3Client();
  
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: path,
    ContentType: contentType,
  });
  
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Get signed download URL
 */
export async function getSignedDownloadUrl(
  path: string,
  expiresIn: number = 3600
): Promise<string> {
  const client = getS3Client();
  
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: path,
  });
  
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Re-sign a stored URL so it has a fresh TTL on every read.
 *
 * Private-ACL `uploadFile` writes a 1-hour presigned URL into the database;
 * after expiry the `<img>` tag breaks. This helper accepts whatever was
 * stored — a presigned URL or a bare key — extracts the S3 key and returns
 * a freshly signed download URL. Local-disk fallback (dev) is passed through
 * because it has no expiry.
 *
 * Idempotent and safe to call on every GET handler.
 */
export async function resolveStorageUrl(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;

  // Local dev fallback — `${LOCAL_STORAGE_PUBLIC_BASE}/storage/...`, no expiry.
  if (stored.startsWith(LOCAL_STORAGE_PUBLIC_BASE)) {
    return stored;
  }

  if (!hasS3Credentials()) {
    return stored;
  }

  // Extract S3 key from either a bare key (`studio/8/...`) or a presigned URL.
  let key: string;
  if (/^https?:\/\//i.test(stored)) {
    try {
      const u = new URL(stored);
      let pathname = u.pathname.replace(/^\/+/, '');
      // forcePathStyle: bucket appears in the path. virtual-hosted style:
      // bucket is in the subdomain, path is just the key.
      if (pathname.startsWith(BUCKET + '/')) {
        pathname = pathname.slice(BUCKET.length + 1);
      }
      key = decodeURIComponent(pathname);
    } catch {
      return stored;
    }
  } else {
    key = stored;
  }

  if (!key) return stored;

  try {
    return await getSignedDownloadUrl(key, 3600);
  } catch (err) {
    logger.warn({ err, key }, 'resolveStorageUrl: failed to sign, returning stored value');
    return stored;
  }
}

/**
 * Delete file from S3
 */
export async function deleteFile(path: string): Promise<void> {
  const client = getS3Client();
  
  await client.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: path,
  }));
}

/**
 * Download file from URL to buffer
 */
export async function downloadToBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
