import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { wbCogs, wbCards } from '../db/schema.js';
import * as XLSX from 'xlsx';
import { requireRole } from '../plugins/roleCheck.js';

function normalizeVendorCode(input: string): string {
  let v = input.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
    v = v.slice(1, -1).trim();
  }
  // If looks like a number with .0 (from Excel), normalize to integer string
  if (/^\d+\.0+$/.test(v)) v = v.split('.')[0]!;
  return v.toLowerCase();
}

/**
 * Lowercase + strip non-alphanumeric chars from a header key. Lets us match
 * "Себестоимость, ₽", "cost rub", "Cost-Rub", "COSTRUB" to the same canonical
 * key when looking up column synonyms.
 */
function normaliseHeader(s: string): string {
  return String(s).toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
}

/**
 * Find the first non-empty value in `row` whose column header matches one of
 * the synonyms. Match modes (in order): exact normalised, header startsWith
 * synonym, header contains synonym. Empty values (null/undefined/'') are
 * skipped — caller can still detect a "matched but empty" situation by
 * inspecting the raw row, but for our import purposes we want to fall through
 * to the next synonym/column.
 *
 * Examples:
 *   getColumnValue({ 'costRub': 500 },              ['costRub']) === 500
 *   getColumnValue({ 'Cost-Rub': 500 },             ['costRub']) === 500    // exact after normalise
 *   getColumnValue({ 'Себестоимость, ₽': 250 },     ['себестоимость']) === 250  // startsWith
 *   getColumnValue({ 'Закупочная цена, руб.': 100 },['закупочнаяцена']) === 100 // startsWith
 *
 * Exported for tests.
 */
export function getColumnValue(row: Record<string, unknown>, synonyms: string[]): unknown {
  const wanted = synonyms.map(normaliseHeader).filter((s) => s.length > 0);
  for (const [key, val] of Object.entries(row)) {
    if (val === null || val === undefined || val === '') continue;
    const norm = normaliseHeader(key);
    for (const w of wanted) {
      if (norm === w || norm.startsWith(w)) return val;
    }
  }
  return undefined;
}

const COST_SYNONYMS = [
  'costRub', 'cogsRub', 'cost', 'cogs',
  'себестоимость', 'стоимость',
  'закупочная цена', 'цена закупки', 'закупка',
  'себестоимостьруб', 'себестоимостьр', 'себестоимостьрублей',
  'purchase_price', 'purchasePrice', 'buy_price', 'buyPrice',
];
const NMID_SYNONYMS = [
  'nmId', 'nm_id', 'nmid', 'nm id',
  'артикул wb', 'артикул вб', 'wb_id', 'sku',
];
const VENDOR_SYNONYMS = [
  'vendorCode', 'vendor_code', 'vendor code', 'vendor',
  'артикул продавца', 'артикулпродавца', 'артикул',
  'supplier_article', 'supplierArticle',
];

// workspace-level: shopId не применяется — COGS привязаны к nmId без разделения по магазинам
export const cogsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Покрытие cogs: сколько артикулов с указанной себестоимостью vs всего.
   * Возвращает счётчики + 200 артикулов без cogs (для скачивания CSV).
   */
  app.get('/cogs/:workspaceId/coverage', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const ws = params.workspaceId;

    const [allCards, withCogs] = await Promise.all([
      db.select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode, title: wbCards.title })
        .from(wbCards)
        .where(eq(wbCards.workspaceId, ws)),
      db.select({ nmId: wbCogs.nmId })
        .from(wbCogs)
        .where(and(eq(wbCogs.workspaceId, ws), sql`${wbCogs.cogsKopecks} > 0`)),
    ]);

    const withSet = new Set(withCogs.map((r) => Number(r.nmId)));
    const without = allCards.filter((c) => !withSet.has(Number(c.nmId)));

    return {
      total: allCards.length,
      withCogs: withCogs.length,
      withoutCogs: without.length,
      coveragePct: allCards.length > 0 ? Math.round((withCogs.length / allCards.length) * 1000) / 10 : 0,
      missingSample: without.slice(0, 200).map((c) => ({
        nmId: Number(c.nmId),
        vendorCode: c.vendorCode ?? '',
        title: c.title ?? '',
      })),
    };
  });

  /**
   * Template download: ALL articles with their current cogs (or null).
   * Used by the frontend "Скачать шаблон" button to pre-populate real data.
   */
  app.get('/cogs/:workspaceId/template', { preHandler: requireRole('viewer') }, async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const ws = params.workspaceId;

    const rows = await db
      .select({
        vendorCode: wbCards.vendorCode,
        nmId: wbCards.nmId,
        title: wbCards.title,
        cogsKopecks: wbCogs.cogsKopecks,
      })
      .from(wbCards)
      .leftJoin(wbCogs, and(
        eq(wbCogs.workspaceId, wbCards.workspaceId),
        eq(wbCogs.nmId, wbCards.nmId),
      ))
      .where(eq(wbCards.workspaceId, ws))
      .orderBy(asc(wbCards.vendorCode));

    return {
      rows: rows.map((r) => ({
        vendorCode: r.vendorCode ?? '',
        nmId: Number(r.nmId),
        title: r.title ?? '',
        cogsRub: r.cogsKopecks != null && Number(r.cogsKopecks) > 0
          ? Number(r.cogsKopecks) / 100
          : null,
      })),
    };
  });

  app.get('/cogs/:workspaceId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ nmIds: z.string().optional() }).parse(req.query);

    const nmIds = (query.nmIds ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);


    const rows = nmIds.length
      ? await db
          .select()
          .from(wbCogs)
          .where(and(eq(wbCogs.workspaceId, params.workspaceId), inArray(wbCogs.nmId, nmIds)))
      : await db.select().from(wbCogs).where(eq(wbCogs.workspaceId, params.workspaceId));

    return { workspaceId: params.workspaceId, rows };
  });

  app.post('/cogs/:workspaceId', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        nmId: z.coerce.number().int().positive(),
        cogsRub: z.coerce.number().min(0),
      })
      .parse(req.body);

    const cogsKopecks = Math.round(body.cogsRub * 100);

    await db
      .insert(wbCogs)
      .values({
        workspaceId: params.workspaceId,
        nmId: body.nmId,
        cogsKopecks,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wbCogs.workspaceId, wbCogs.nmId],
        set: {
          cogsKopecks,
          updatedAt: new Date(),
        },
      });

    return { ok: true };
  });

  // ── Import COGS from XLSX (base64 encoded) ──────────────────────────────
  // Max file size: 10MB (base64 is ~33% larger than binary)
  const MAX_XLSX_BASE64_SIZE = 14 * 1024 * 1024; // ~10MB binary → ~14MB base64
  
  app.post('/cogs/import/xlsx', { preHandler: requireRole('manager') },async (req) => {
    const body = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        actorUserId: z.coerce.number().int().optional(),
        xlsxBase64: z.string().min(1).max(MAX_XLSX_BASE64_SIZE, 'File too large (max 10MB)'),
        overwrite: z.boolean().optional().default(true),
        dryRun: z.boolean().optional().default(false),
      })
      .parse(req.body);

    const buffer = Buffer.from(body.xlsxBase64, 'base64');
    
    // Additional size check after decoding
    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('File too large (max 10MB)');
    }
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    if (!ws) throw new Error('Пустой xlsx-файл');

    const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

    // Capture detected column headers so we can return a useful hint when
    // header matching fails for every row (typical "файл с другими именами
    // столбцов" UX failure mode).
    const detectedColumns = rawRows.length > 0
      ? Array.from(new Set(rawRows.flatMap((r) => Object.keys(r ?? {}))))
      : [];

    // Normalize rows — support columns: nmId, vendorCode, costRub/cogsRub
    type ParsedRow = { nmId?: number; vendorCode?: string; costRub: number };
    const parsed: ParsedRow[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i]!;
      const rowNum = i + 2; // +2 because header=row1, data starts at row2

      // Try to find costRub (case-insensitive across aliased headers)
      const costVal = getColumnValue(row, COST_SYNONYMS);
      if (costVal == null) {
        errors.push(`Строка ${rowNum}: нет costRub/cogsRub`);
        continue;
      }
      const costRub = Number(costVal);
      if (!Number.isFinite(costRub) || costRub < 0) {
        errors.push(`Строка ${rowNum}: некорректная себестоимость "${costVal}"`);
        continue;
      }

      // Try to find nmId or vendorCode
      const rawNmId = getColumnValue(row, NMID_SYNONYMS);
      const rawVendorCode = getColumnValue(row, VENDOR_SYNONYMS);
      const nmId = rawNmId != null ? Number(rawNmId) : undefined;
      const vendorCode = rawVendorCode != null ? normalizeVendorCode(String(rawVendorCode)) : undefined;

      if (!nmId && !vendorCode) {
        errors.push(`Строка ${rowNum}: нет nmId или vendorCode`);
        continue;
      }

      parsed.push({
        nmId: nmId && Number.isFinite(nmId) && nmId > 0 ? nmId : undefined,
        vendorCode,
        costRub,
      });
    }

    // Resolve vendorCodes → nmIds
    const vendorCodesToResolve = Array.from(new Set(
      parsed
        .filter((r) => !r.nmId && r.vendorCode)
        .map((r) => r.vendorCode!)
        .filter((v) => v && v.length > 0)
    ));


    const vcToNm = new Map<string, number>();
    if (vendorCodesToResolve.length > 0) {
      // Batch-resolve in chunks of 500
      for (let i = 0; i < vendorCodesToResolve.length; i += 500) {
        const chunk = vendorCodesToResolve.slice(i, i + 500);
        const normalizedChunk = chunk.map((v) => normalizeVendorCode(v));
        const cards = await db
          .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode })
          .from(wbCards)
          .where(
            and(
              eq(wbCards.workspaceId, body.workspaceId),
              inArray(sql`lower(trim(${wbCards.vendorCode}))`, normalizedChunk)
            )
          );
        for (const c of cards) {
          if (c.vendorCode) vcToNm.set(normalizeVendorCode(c.vendorCode), c.nmId);
        }
      }

      // Fallback: if vendorCode is actually nmId (digits), try matching by nmId
      const numericCandidates = vendorCodesToResolve
        .filter((v) => /^\d+$/.test(v))
        .map((v) => Number.parseInt(v, 10))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (numericCandidates.length > 0) {
        for (let i = 0; i < numericCandidates.length; i += 500) {
          const chunk = numericCandidates.slice(i, i + 500);
          const cards = await db
            .select({ nmId: wbCards.nmId })
            .from(wbCards)
            .where(and(eq(wbCards.workspaceId, body.workspaceId), inArray(wbCards.nmId, chunk)));
          for (const c of cards) {
            vcToNm.set(String(c.nmId), c.nmId);
          }
        }
      }
    }

    let imported = 0;
    let skipped = 0;

    for (const row of parsed) {
      let nmId = row.nmId;
      if (!nmId && row.vendorCode) {
        nmId = vcToNm.get(row.vendorCode);
        if (!nmId) {
          skipped++;
          errors.push(`vendorCode "${row.vendorCode}" не найден в базе (проверьте синхронизацию карточек или формат столбца)`);
          continue;
        }
      }
      if (!nmId) { skipped++; continue; }

      if (!body.dryRun) {
        const cogsKopecks = Math.round(row.costRub * 100);
        await db
          .insert(wbCogs)
          .values({ workspaceId: body.workspaceId, nmId, cogsKopecks, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [wbCogs.workspaceId, wbCogs.nmId],
            set: { cogsKopecks, updatedAt: new Date() },
          });
      }
      imported++;
    }

    // Build a user-friendly hint when nothing imported. Most common cause:
    // user's xlsx has cost/article columns under names we don't recognise.
    let hint: string | undefined;
    if (imported === 0 && rawRows.length > 0) {
      const allCostMissing = errors.every((e) => /нет costRub\/cogsRub/.test(e));
      if (allCostMissing) {
        hint = `Не нашёл столбец себестоимости в файле. Найденные столбцы: ${detectedColumns.length ? detectedColumns.map((c) => `«${c}»`).join(', ') : '(пусто)'}. Переименуйте один из них в costRub / cogsRub / Себестоимость и попробуйте снова.`;
      } else if (errors.some((e) => /нет nmId или vendorCode/.test(e))) {
        hint = `Не нашёл столбец артикула. Нужен nmId или vendorCode. Найденные столбцы: ${detectedColumns.map((c) => `«${c}»`).join(', ')}.`;
      }
    }

    return {
      ok: true,
      dryRun: body.dryRun,
      totalRowsInFile: rawRows.length,
      detectedColumns,
      imported,
      skipped,
      errors: errors.slice(0, 50), // limit errors output
      ...(hint ? { hint } : {}),
    };
  });
};
