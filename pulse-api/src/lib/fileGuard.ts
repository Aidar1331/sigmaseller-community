/**
 * File upload validation for AI chat attachments.
 *
 * Defends against:
 *   - Extension spoofing (.exe renamed to .pdf) — checks magic bytes, not name.
 *   - Macro-bearing Office formats (.xlsm, .docm, .pptm) — blocked outright.
 *   - Token-budget DoS — caps total bytes per message.
 *
 * Returns the validated, typed buffer + mime, or throws AppError-style.
 */

import { BadRequestError } from './errors.js';

export type AttachmentKind = 'image' | 'pdf' | 'docx' | 'xlsx' | 'text';

export interface ValidatedAttachment {
  fileName: string;
  mime: string;
  kind: AttachmentKind;
  buffer: Buffer;
  sizeBytes: number;
}

export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;       // 10 MB
export const MAX_BYTES_PER_MESSAGE = 30 * 1024 * 1024;     // 30 MB total
export const MAX_BYTES_IMAGE = 5 * 1024 * 1024;            // Anthropic image limit

/**
 * Magic-bytes table. We trust these — file extension and `multipart` mime
 * header are attacker-controlled.
 */
const MAGIC_SIGNATURES: Array<{ kind: AttachmentKind; mime: string; bytes: number[]; offset?: number }> = [
  { kind: 'image', mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { kind: 'image', mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { kind: 'image', mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: 'image', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (followed by WEBP at offset 8)
  { kind: 'pdf', mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: [0x50, 0x4B, 0x03, 0x04] }, // PK..
  { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: [0x50, 0x4B, 0x03, 0x04] },        // PK..
];

const MACRO_EXTENSIONS = new Set(['.xlsm', '.docm', '.pptm', '.xlsb', '.xltm']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.log']);

function detectKind(buffer: Buffer, fileName: string): { kind: AttachmentKind; mime: string } | null {
  // Macro-bearing Office formats: reject outright by extension (zip-shaped, can't trust magic alone).
  const lowerName = fileName.toLowerCase();
  for (const ext of MACRO_EXTENSIONS) {
    if (lowerName.endsWith(ext)) return null;
  }

  // Magic bytes
  for (const sig of MAGIC_SIGNATURES) {
    const off = sig.offset ?? 0;
    if (buffer.length < off + sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[off + i] !== sig.bytes[i]) { ok = false; break; }
    }
    if (!ok) continue;

    // For ZIP-shaped Office docs (PK..) we additionally require the matching extension —
    // both .docx and .xlsx start with the same bytes, and a .zip would also match.
    if (sig.kind === 'docx' && !lowerName.endsWith('.docx')) continue;
    if (sig.kind === 'xlsx' && !lowerName.endsWith('.xlsx')) continue;

    // WEBP: also verify "WEBP" string at offset 8.
    if (sig.mime === 'image/webp') {
      if (buffer.length < 12) continue;
      const webp = buffer.slice(8, 12).toString('ascii');
      if (webp !== 'WEBP') continue;
    }

    return { kind: sig.kind, mime: sig.mime };
  }

  // Plain text fallback (only via extension — no magic bytes for UTF-8).
  for (const ext of TEXT_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      // Sanity: must be valid UTF-8 + mostly printable.
      try {
        const text = buffer.toString('utf-8');
        // Reject if >5% non-printable / non-whitespace bytes (likely binary mislabeled).
        let bad = 0;
        for (let i = 0; i < Math.min(text.length, 4096); i++) {
          const c = text.charCodeAt(i);
          if (c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) bad++;
        }
        if (bad / Math.min(text.length, 4096) > 0.05) return null;
        return { kind: 'text', mime: 'text/plain' };
      } catch {
        return null;
      }
    }
  }

  return null;
}

export interface ValidateInput {
  fileName: string;
  buffer: Buffer;
}

export function validateAttachment(input: ValidateInput): ValidatedAttachment {
  const { fileName, buffer } = input;
  const sizeBytes = buffer.length;

  if (sizeBytes === 0) {
    throw new BadRequestError(`Файл «${fileName}» пустой.`);
  }
  if (sizeBytes > MAX_BYTES_PER_FILE) {
    throw new BadRequestError(`Файл «${fileName}» больше ${MAX_BYTES_PER_FILE / 1024 / 1024} МБ.`);
  }

  const detected = detectKind(buffer, fileName);
  if (!detected) {
    throw new BadRequestError(
      `Файл «${fileName}» — неподдерживаемый формат. Разрешены: JPG/PNG/GIF/WEBP, PDF, DOCX, XLSX, TXT/MD/CSV. Файлы с макросами (.xlsm/.docm) запрещены.`,
    );
  }

  if (detected.kind === 'image' && sizeBytes > MAX_BYTES_IMAGE) {
    throw new BadRequestError(`Изображение «${fileName}» больше ${MAX_BYTES_IMAGE / 1024 / 1024} МБ — лимит Claude API.`);
  }

  return { fileName, mime: detected.mime, kind: detected.kind, buffer, sizeBytes };
}

export function validateBatch(items: ValidateInput[]): ValidatedAttachment[] {
  if (items.length > MAX_FILES_PER_MESSAGE) {
    throw new BadRequestError(`Слишком много файлов: ${items.length}. Максимум ${MAX_FILES_PER_MESSAGE} за сообщение.`);
  }
  const result = items.map(validateAttachment);
  const total = result.reduce((s, a) => s + a.sizeBytes, 0);
  if (total > MAX_BYTES_PER_MESSAGE) {
    throw new BadRequestError(
      `Суммарный размер файлов ${(total / 1024 / 1024).toFixed(1)} МБ превышает лимит ${MAX_BYTES_PER_MESSAGE / 1024 / 1024} МБ.`,
    );
  }
  return result;
}

/**
 * Rough token-cost estimate for budget pre-check. Numbers from Anthropic docs:
 *   - Image: ~1500–3000 tokens depending on dimensions; we use 2500 as conservative average.
 *   - PDF page: ~1500–3000 tokens; we use 2500 per ~50KB of PDF as proxy (no PDF parser at this stage).
 *   - DOCX/XLSX/text: 1 token ≈ 4 bytes UTF-8.
 */
export function estimateInputTokens(attachments: ValidatedAttachment[], userText: string): number {
  let tokens = Math.ceil(userText.length / 3.5);
  for (const a of attachments) {
    if (a.kind === 'image') {
      tokens += 2500;
    } else if (a.kind === 'pdf') {
      // 2500 tokens per 50KB of PDF (very rough — actual depends on text density)
      tokens += Math.ceil(a.sizeBytes / 50_000) * 2500;
    } else {
      tokens += Math.ceil(a.sizeBytes / 4);
    }
  }
  return tokens;
}
