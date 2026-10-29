import { requireSellerAiKey } from '../services/sellerAiCredentials.js';
import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt, ilike, between, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
// TODO: Add these tables to schema.ts when creative module is implemented
// import { creativeVisualJobs, creativeVisualAssets, creativeVisualSlides, seoJobs } from '../db/schema.js';
import { wbCards } from '../db/schema.js';

// Placeholder tables until schema is updated
const creativeVisualJobs = null as any;
const creativeVisualAssets = null as any;
const creativeVisualSlides = null as any;
const seoJobs = null as any;
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { env } from '../env.js';
import { requireRole } from '../plugins/roleCheck.js';
import { aiSingleRateLimit } from '../lib/expensiveRouteLimits.js';

function buildTextContext(card: any): string {
  const title = card?.title || '';
  const desc = card?.description || card?.cardDescription || '';
  const chars = card?.characteristics || card?.options || [];

  const parts: string[] = [];
  if (title) parts.push(`Название: ${title}`);
  if (desc) parts.push(`Описание: ${desc}`);
  if (Array.isArray(chars) && chars.length) {
    const lines = chars
      .map((c: any) => {
        const name = c?.name || c?.title || '';
        const value = c?.value ?? c?.values ?? '';
        if (!name || value === undefined || value === null) return null;
        return `${name}: ${Array.isArray(value) ? value.join(', ') : value}`;
      })
      .filter(Boolean);
    if (lines.length) parts.push(`Характеристики:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

function photoUrlsFromRow(row: any): string[] {
  const photos = Array.isArray(row?.photos) ? row.photos : [];
  return photos
    .map((p: any) => p?.big || p?.c516x688 || p?.c246x328 || p?.tm)
    .filter((u: any) => typeof u === 'string');
}

async function callOpenAiVision(opts: { prompt: string; context: string; photoUrls: string[] }) {
  if (!(await requireSellerAiKey('openai'))) {
    throw new BadRequestError('OPENAI_API_KEY is not configured');
  }

  const model = env.OPENAI_VISION_MODEL || 'gpt-4o';

  const messages = [
    { role: 'system', content: opts.prompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Контекст товара:\n${opts.context || '(нет)'}` },
        ...opts.photoUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(await requireSellerAiKey('openai'))}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1800,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new BadRequestError(`OpenAI error: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content || '';
}

async function callOpenAiText(prompt: string) {
  if (!(await requireSellerAiKey('openai'))) {
    throw new BadRequestError('OPENAI_API_KEY is not configured');
  }

  const model = env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(await requireSellerAiKey('openai'))}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a marketplace SEO copywriter.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 800,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new BadRequestError(`OpenAI error: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content || '';
}

function parseQueries(raw?: string): Array<{ query: string; weight?: number }> {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s*[;|\t]\s*/);
      if (parts.length >= 2) {
        const w = Number(parts[1]);
        return { query: parts[0], weight: Number.isFinite(w) ? w : undefined };
      }
      return { query: line };
    });
}

function tryParseJson(text: string): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const creativeRoutes: FastifyPluginAsync = async (app) => {
  // -----------------------------------------------------------------------
  // Visual Audit (PoC) — synchronous run
  // -----------------------------------------------------------------------
  app.post('/creative/visual-audit/:workspaceId', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        nmId: z.coerce.number().int().positive(),
        note: z.string().optional(),
      })
      .parse((req as any).body ?? {});


    const [row] = await db
      .select({
        nmId: wbCards.nmId,
        title: wbCards.title,
        photos: wbCards.photos,
        raw: wbCards.raw,
      })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, params.workspaceId), eq(wbCards.nmId, body.nmId)))
      .limit(1);

    if (!row) throw new NotFoundError('Card not found');

    const photoUrls = photoUrlsFromRow(row);
    if (!photoUrls.length) throw new BadRequestError('Card has no photos');

    const context = buildTextContext(row.raw || {});
    const note = body.note ? `\n\nДоп. заметки пользователя:\n${body.note}` : '';

    const prompt =
      'You are a senior product psychologist, marketplace marketer, and creative director. ' +
      'Analyse the product photos and build a strong visual funnel. ' +
      'Return ONLY valid JSON (no markdown).\n\n' +
      'Schema: {\n' +
      '  "summary": string,\n' +
      '  "strengths": string[],\n' +
      '  "weaknesses": string[],\n' +
      '  "utps": string[],\n' +
      '  "missing_elements": string[],\n' +
      '  "slide_plan": [\n' +
      '    {"order": number, "title": string, "goal": string, "utp": string, "copy": string, "layout_hint": string}\n' +
      '  ],\n' +
      '  "designer_tasks": string[]\n' +
      '}';

    const analysis = await callOpenAiVision({
      prompt,
      context: context + note,
      photoUrls,
    });

    const parsed = tryParseJson(analysis);

    const { randomUUID } = await import('node:crypto');
    const jobId = randomUUID();

    await db.insert(creativeVisualJobs).values({
      jobId,
      workspaceId: params.workspaceId,
      nmId: body.nmId,
      status: 'done',
      promptVersion: 'v2-json',
      inputText: context + note,
      outputText: analysis,
      outputJson: parsed ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const assets = photoUrls.map((url) => ({
      jobId,
      kind: 'source_photo',
      url,
      meta: {},
      createdAt: new Date(),
    }));
    if (assets.length) {
      await db.insert(creativeVisualAssets).values(assets);
    }

    const slides = Array.isArray(parsed?.slide_plan) ? parsed.slide_plan : [];
    if (slides.length) {
      const rows = slides.map((s: any, i: number) => ({
        jobId,
        sortOrder: Number(s.order ?? i + 1),
        title: s.title ?? null,
        goal: s.goal ?? null,
        utp: s.utp ?? null,
        copy: s.copy ?? null,
        layoutHint: s.layout_hint ?? null,
        meta: {},
        createdAt: new Date(),
      }));
      await db.insert(creativeVisualSlides).values(rows);
    }

    return {
      ok: true,
      jobId,
      nmId: body.nmId,
      analysis,
      structured: parsed ?? null,
      photoUrls,
      context,
    };
  });

  // -----------------------------------------------------------------------
  // Visual Audit jobs list
  // -----------------------------------------------------------------------
  app.get('/creative/visual-audit/:workspaceId/jobs', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ nmId: z.coerce.number().int().optional() }).parse(req.query);

    const where = [eq(creativeVisualJobs.workspaceId, params.workspaceId)];
    if (query.nmId) where.push(eq(creativeVisualJobs.nmId, query.nmId));

    const rows = await db
      .select({
        jobId: creativeVisualJobs.jobId,
        nmId: creativeVisualJobs.nmId,
        status: creativeVisualJobs.status,
        promptVersion: creativeVisualJobs.promptVersion,
        createdAt: creativeVisualJobs.createdAt,
        updatedAt: creativeVisualJobs.updatedAt,
      })
      .from(creativeVisualJobs)
      .where(and(...where))
      .orderBy(desc(creativeVisualJobs.createdAt))
      .limit(50);

    return { ok: true, workspaceId: params.workspaceId, rows };
  });

  // -----------------------------------------------------------------------
  // Visual Audit job details (with slides + assets)
  // -----------------------------------------------------------------------
  app.get('/creative/visual-audit/:workspaceId/jobs/:jobId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        jobId: z.string().min(6),
      })
      .parse(req.params);


    const [job] = await db
      .select({
        jobId: creativeVisualJobs.jobId,
        nmId: creativeVisualJobs.nmId,
        status: creativeVisualJobs.status,
        promptVersion: creativeVisualJobs.promptVersion,
        inputText: creativeVisualJobs.inputText,
        outputText: creativeVisualJobs.outputText,
        outputJson: creativeVisualJobs.outputJson,
        createdAt: creativeVisualJobs.createdAt,
        updatedAt: creativeVisualJobs.updatedAt,
      })
      .from(creativeVisualJobs)
      .where(and(eq(creativeVisualJobs.workspaceId, params.workspaceId), eq(creativeVisualJobs.jobId, params.jobId)))
      .limit(1);

    if (!job) throw new NotFoundError('Job not found');

    const assets = await db
      .select({
        assetId: creativeVisualAssets.assetId,
        kind: creativeVisualAssets.kind,
        url: creativeVisualAssets.url,
        meta: creativeVisualAssets.meta,
        createdAt: creativeVisualAssets.createdAt,
      })
      .from(creativeVisualAssets)
      .where(eq(creativeVisualAssets.jobId, params.jobId))
      .orderBy(asc(creativeVisualAssets.assetId));

    const assetsWithUrl = assets.map((a) => ({
      ...a,
      downloadUrl: `/creative/visual-audit/${params.workspaceId}/assets/${a.assetId}/download`,
    }));

    const slides = await db
      .select({
        slideId: creativeVisualSlides.slideId,
        sortOrder: creativeVisualSlides.sortOrder,
        title: creativeVisualSlides.title,
        goal: creativeVisualSlides.goal,
        utp: creativeVisualSlides.utp,
        copy: creativeVisualSlides.copy,
        layoutHint: creativeVisualSlides.layoutHint,
        meta: creativeVisualSlides.meta,
      })
      .from(creativeVisualSlides)
      .where(eq(creativeVisualSlides.jobId, params.jobId))
      .orderBy(asc(creativeVisualSlides.sortOrder));

    return { ok: true, job, assets: assetsWithUrl, slides };
  });

  // -----------------------------------------------------------------------
  // Generate slide image (OpenAI Images)
  // -----------------------------------------------------------------------
  app.post('/creative/visual-audit/:workspaceId/jobs/:jobId/slides/:slideId/generate', {
    preHandler: requireRole('manager'),
    config: aiSingleRateLimit,
  },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        jobId: z.string().min(6),
        slideId: z.coerce.number().int().positive(),
      })
      .parse(req.params);

    const body = z
      .object({
        promptOverride: z.string().max(4000).optional(),
        provider: z.enum(['openai', 'gemini', 'ideogram', 'firefly']).optional(),
      })
      .parse((req as any).body ?? {});


    const [job] = await db
      .select({
        jobId: creativeVisualJobs.jobId,
        workspaceId: creativeVisualJobs.workspaceId,
        outputJson: creativeVisualJobs.outputJson,
      })
      .from(creativeVisualJobs)
      .where(and(eq(creativeVisualJobs.jobId, params.jobId), eq(creativeVisualJobs.workspaceId, params.workspaceId)))
      .limit(1);

    if (!job) throw new NotFoundError('Job not found');

    const [slide] = await db
      .select({
        slideId: creativeVisualSlides.slideId,
        title: creativeVisualSlides.title,
        goal: creativeVisualSlides.goal,
        utp: creativeVisualSlides.utp,
        copy: creativeVisualSlides.copy,
        layoutHint: creativeVisualSlides.layoutHint,
      })
      .from(creativeVisualSlides)
      .where(and(eq(creativeVisualSlides.jobId, params.jobId), eq(creativeVisualSlides.slideId, params.slideId)))
      .limit(1);

    if (!slide) throw new NotFoundError('Slide not found');

    const basePrompt = [
      'Marketplace product visual slide. Clean modern design, clear typography, white background, realistic product presentation.',
      slide.title ? `Slide title: ${slide.title}` : '',
      slide.goal ? `Goal: ${slide.goal}` : '',
      slide.utp ? `Strong UTP: ${slide.utp}` : '',
      slide.copy ? `Copy: ${slide.copy}` : '',
      slide.layoutHint ? `Layout: ${slide.layoutHint}` : '',
      'Output: single slide 1024x1024, high contrast, ready for marketplace card.',
    ].filter(Boolean).join('\n');

    const promptOverride = (body.promptOverride || '').trim();
    const prompt = promptOverride ? promptOverride : basePrompt;
    const provider = body.provider || 'openai';

    let b64 = '';
    if (provider === 'openai') {
      const { generateImageBase64 } = await import('../lib/openaiImage.js');
      b64 = await generateImageBase64(prompt);
    } else if (provider === 'gemini') {
      const { generateGeminiImageBase64 } = await import('../lib/geminiImage.js');
      b64 = await generateGeminiImageBase64(prompt);
    } else if (provider === 'ideogram') {
      const { generateIdeogramImageBase64 } = await import('../lib/ideogramImage.js');
      b64 = await generateIdeogramImageBase64(prompt);
    } else if (provider === 'firefly') {
      const { generateFireflyImageBase64 } = await import('../lib/fireflyImage.js');
      b64 = await generateFireflyImageBase64(prompt);
    } else {
      throw new BadRequestError('Unknown provider');
    }
    const buf = Buffer.from(b64, 'base64');

    const path = await import('node:path');
    const fs = await import('node:fs');

    const outDir = path.resolve('out', 'creative', 'visual', params.jobId);
    fs.mkdirSync(outDir, { recursive: true });
    const fileName = `slide_${params.slideId}_${Date.now()}.png`;
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, buf);

    const [asset] = await db
      .insert(creativeVisualAssets)
      .values({
        jobId: params.jobId,
        kind: 'generated_slide',
        url: filePath,
        meta: { slideId: params.slideId, prompt, provider },
        createdAt: new Date(),
      })
      .returning({
        assetId: creativeVisualAssets.assetId,
        url: creativeVisualAssets.url,
      });

    return {
      ok: true,
      asset: {
        assetId: asset.assetId,
        downloadUrl: `/creative/visual-audit/${params.workspaceId}/assets/${asset.assetId}/download`,
        provider,
      },
    };
  });

  // -----------------------------------------------------------------------
  // Download asset
  // -----------------------------------------------------------------------
  app.get('/creative/visual-audit/:workspaceId/assets/:assetId/download', { preHandler: requireRole('viewer') },async (req, reply) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        assetId: z.coerce.number().int().positive(),
      })
      .parse(req.params);


    const [row] = await db
      .select({
        assetId: creativeVisualAssets.assetId,
        url: creativeVisualAssets.url,
        jobId: creativeVisualAssets.jobId,
      })
      .from(creativeVisualAssets)
      .leftJoin(creativeVisualJobs, eq(creativeVisualJobs.jobId, creativeVisualAssets.jobId))
      .where(and(
        eq(creativeVisualAssets.assetId, params.assetId),
        eq(creativeVisualJobs.workspaceId, params.workspaceId)
      ))
      .limit(1);

    if (!row) throw new NotFoundError('Asset not found');

    const path = await import('node:path');
    const fs = await import('node:fs');

    const baseDir = path.resolve('out', 'creative', 'visual');
    const abs = path.resolve(row.url);

    if (!abs.startsWith(baseDir)) {
      throw new NotFoundError('Asset not found');
    }

    if (!fs.existsSync(abs)) {
      throw new NotFoundError('Asset not found');
    }

    reply.header('Content-Type', 'image/png');
    reply.header('Content-Disposition', `attachment; filename="asset_${params.assetId}.png"`);

    return reply.send(fs.createReadStream(abs));
  });

  // -----------------------------------------------------------------------
  // SEO (manual queries input)
  // -----------------------------------------------------------------------
  app.post('/creative/seo/:workspaceId', { preHandler: requireRole('manager') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        nmId: z.coerce.number().int().positive(),
        queries: z.string().optional(),
        note: z.string().optional(),
      })
      .parse((req as any).body ?? {});


    const [row] = await db
      .select({
        nmId: wbCards.nmId,
        raw: wbCards.raw,
      })
      .from(wbCards)
      .where(and(eq(wbCards.workspaceId, params.workspaceId), eq(wbCards.nmId, body.nmId)))
      .limit(1);

    if (!row) throw new NotFoundError('Card not found');

    const context = buildTextContext(row.raw || {});
    const queries = parseQueries(body.queries || '');
    const note = body.note ? `\n\nДоп. заметки пользователя:\n${body.note}` : '';

    const queriesText = queries.length
      ? queries
          .slice(0, 30)
          .map((q) => (q.weight ? `${q.query} (${q.weight})` : q.query))
          .join('\n')
      : '(нет)';

    const prompt =
      'Сгенерируй название и описание для маркетплейса на русском.\n' +
      'Учитывай поисковые запросы и характеристики товара.\n' +
      'Верни строго JSON: {"title": string, "description": string}.\n\n' +
      `Контекст товара:\n${context}${note}\n\n` +
      `Поисковые запросы:\n${queriesText}`;

    const text = await callOpenAiText(prompt);
    const parsed = tryParseJson(text) || {};

    const title = parsed.title || null;
    const description = parsed.description || text;

    const { randomUUID } = await import('node:crypto');
    const jobId = randomUUID();

    await db.insert(seoJobs).values({
      jobId,
      workspaceId: params.workspaceId,
      nmId: body.nmId,
      status: 'done',
      queriesJson: queries as any,
      inputText: context + note,
      outputTitle: title,
      outputDescription: description,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { ok: true, jobId, title, description };
  });

  app.get('/creative/seo/:workspaceId/jobs', { preHandler: requireRole('viewer') },async (req) => {
    const params = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.params);
    const query = z.object({ nmId: z.coerce.number().int().optional() }).parse(req.query);

    const where = [eq(seoJobs.workspaceId, params.workspaceId)];
    if (query.nmId) where.push(eq(seoJobs.nmId, query.nmId));

    const rows = await db
      .select({
        jobId: seoJobs.jobId,
        nmId: seoJobs.nmId,
        status: seoJobs.status,
        outputTitle: seoJobs.outputTitle,
        outputDescription: seoJobs.outputDescription,
        createdAt: seoJobs.createdAt,
        updatedAt: seoJobs.updatedAt,
      })
      .from(seoJobs)
      .where(and(...where))
      .orderBy(desc(seoJobs.createdAt))
      .limit(50);

    return { ok: true, workspaceId: params.workspaceId, rows };
  });

  app.get('/creative/seo/:workspaceId/jobs/:jobId', { preHandler: requireRole('viewer') },async (req) => {
    const params = z
      .object({
        workspaceId: z.coerce.number().int().positive(),
        jobId: z.string().min(6),
      })
      .parse(req.params);

    const [row] = await db
      .select({
        jobId: seoJobs.jobId,
        nmId: seoJobs.nmId,
        status: seoJobs.status,
        queriesJson: seoJobs.queriesJson,
        inputText: seoJobs.inputText,
        outputTitle: seoJobs.outputTitle,
        outputDescription: seoJobs.outputDescription,
        createdAt: seoJobs.createdAt,
        updatedAt: seoJobs.updatedAt,
      })
      .from(seoJobs)
      .where(and(eq(seoJobs.workspaceId, params.workspaceId), eq(seoJobs.jobId, params.jobId)))
      .limit(1);

    if (!row) throw new NotFoundError('SEO job not found');
    return { ok: true, job: row };
  });
};
