/**
 * AI Chat SSE Endpoint.
 *
 * POST /ai/chat          — Send message, stream response via SSE
 * POST /ai/chat/resume   — Resume interrupted conversation (after confirmation)
 * GET  /ai/conversations  — List conversations
 * GET  /ai/conversations/:id — Get conversation with messages
 * DELETE /ai/conversations/:id — Archive conversation
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { db } from '../db/client.js';
import { agentConversations, agentMessages, agentSettings, wbAlertSettings, workspaces, marketplaceShops } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { requireRole } from '../plugins/roleCheck.js';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { buildAgentGraph } from '../agents/assistant/graph.js';
import type { PromptContext } from '../agents/assistant/systemPrompt.js';
import { randomUUID } from 'crypto';
import { checkTokenBudget } from '../services/aiSettings.js';
import { validateBatch, MAX_BYTES_PER_FILE, type ValidatedAttachment } from '../lib/fileGuard.js';
import { runMultimodalTurn } from '../agents/assistant/multimodalRunner.js';
import { sendTelegramMessage } from '../integrations/telegram.js';

/**
 * rev 27M.2: when a conversation originated in the Telegram bot
 * (meta.source = 'telegram'), pipe assistant replies back to the user's
 * Telegram chat so two-way sync works — type in the web UI, reply lands
 * in Telegram and vice versa.
 *
 * Safe-fire: a failure to push to Telegram does NOT fail the web turn.
 * The DB still has the message; the user just won't see it in TG.
 */
async function pushAssistantToTelegramIfBotConv(
  conversationId: number,
  text: string,
): Promise<void> {
  if (!text || !text.trim()) return;
  try {
    const rows = await db
      .select({ meta: agentConversations.meta })
      .from(agentConversations)
      .where(eq(agentConversations.conversationId, conversationId))
      .limit(1);
    const meta = rows[0]?.meta as { source?: string; tgChatId?: string } | undefined;
    if (!meta || meta.source !== 'telegram' || !meta.tgChatId) return;
    // Plain text — strip any [BUTTON: ...] markers that the LangGraph
    // assistant may emit; the bot's own parser handles those, but we just
    // want a clean message here.
    const visible = text.replace(/\[BUTTON:[^\]]*\]/g, '').trim();
    if (!visible) return;
    const prefix = '💬 <i>(ответ из веб-кабинета SigmaSeller)</i>\n\n';
    await sendTelegramMessage(meta.tgChatId, prefix + visible, { parseMode: 'HTML' });
  } catch {
    // Don't let push failure break the web turn.
  }
}

// ── SSE Connection Tracking (rate limit) ───────────────────

const MAX_SSE_PER_USER = 3;
const activeConnections = new Map<number, Set<string>>(); // userId -> Set<connId>

// Periodic cleanup of empty connection sets (prevent memory leak)
setInterval(() => {
  for (const [uid, conns] of activeConnections) {
    if (conns.size === 0) activeConnections.delete(uid);
  }
}, 5 * 60 * 1000);

function trackConnection(userId: number | null): string | null {
  const uid = userId ?? 0; // Use 0 for anonymous users
  const conns = activeConnections.get(uid) ?? new Set();
  if (conns.size >= MAX_SSE_PER_USER) {
    // Evict oldest
    const oldest = conns.values().next().value;
    if (oldest) conns.delete(oldest);
  }
  const connId = crypto.randomUUID();
  conns.add(connId);
  activeConnections.set(uid, conns);
  return connId;
}

function releaseConnection(userId: number | null, connId: string) {
  const uid = userId ?? 0;
  const conns = activeConnections.get(uid);
  if (conns) {
    conns.delete(connId);
    if (conns.size === 0) activeConnections.delete(uid);
  }
}

// ── SSE Event Helpers ──────────────────────────────────────

function createSseEmitter() {
  let counter = 0;
  return function sseEvent(type: string, data: unknown, id?: string): string {
    const eid = id ?? String(++counter);
    return `id: ${eid}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  };
}

// ── Route Plugin ───────────────────────────────────────────

export const aiChatRoutes: FastifyPluginAsync = async (app) => {
  // Multipart for file attachments (per-message limits, hard 10MB/file enforced
  // by fastify before our own validateBatch). Encapsulated to this plugin so
  // it doesn't conflict with documentHub's own multipart registration.
  await app.register(multipart, {
    limits: { fileSize: MAX_BYTES_PER_FILE, files: 5 },
  });

  // Lazy compile graph (singleton)
  let _graph: Awaited<ReturnType<typeof buildAgentGraph>> | null = null;
  async function getGraph() {
    if (!_graph) _graph = await buildAgentGraph();
    return _graph;
  }

  /**
   * Parse a multipart-encoded /ai/chat request: extracts text fields
   * (`message`, `conversationId`, `shopId`) and validates file parts via
   * `fileGuard`. Returns the same shape as the JSON `body` schema would,
   * plus an `attachments` array.
   */
  async function parseMultipartChatRequest(req: any): Promise<{
    conversationId?: number;
    message: string;
    shopId?: number;
    attachments: ValidatedAttachment[];
  }> {
    let message = '';
    let conversationId: number | undefined;
    let shopId: number | undefined;
    const fileItems: Array<{ fileName: string; buffer: Buffer }> = [];

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        fileItems.push({ fileName: part.filename || `file-${Date.now()}`, buffer: buf });
      } else if (part.type === 'field') {
        if (part.fieldname === 'message' && typeof part.value === 'string') message = part.value;
        else if (part.fieldname === 'conversationId' && typeof part.value === 'string') {
          const n = Number(part.value);
          if (Number.isFinite(n) && n > 0) conversationId = n;
        } else if (part.fieldname === 'shopId' && typeof part.value === 'string') {
          const n = Number(part.value);
          if (Number.isFinite(n) && n > 0) shopId = n;
        }
      }
    }

    if (!message && fileItems.length === 0) {
      throw new Error('Пустое сообщение — добавьте текст или файл.');
    }
    if (message.length > 4000) {
      throw new Error('Текст сообщения не может быть длиннее 4000 символов.');
    }

    const attachments = fileItems.length > 0 ? validateBatch(fileItems) : [];
    return { conversationId, message, shopId, attachments };
  }

  /**
   * POST /ai/chat — Send a message and stream response.
   */
  app.post('/ai/chat', {
    preHandler: requireRole('viewer'),
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => `ai-chat:${req.user?.userId ?? req.ip}`,
      },
    },
  }, async (req, reply) => {
    const sseEvent = createSseEmitter();
    const queryParams = z.object({ workspaceId: z.coerce.number().int().positive(), shopId: z.coerce.number().int().positive().optional() }).parse(req.query);
    const wsId = queryParams.workspaceId;
    const userId: number | null = (req as any).user?.userId ?? null;

    // Check token budget
    try {
      const budgetOk = await checkTokenBudget(wsId);
      if (!budgetOk) {
        return reply.code(429).send({ error: 'token_budget_exceeded', message: 'Дневной лимит AI-токенов исчерпан. Попробуйте завтра.' });
      }
    } catch (err) {
      req.log.error({ err }, 'Token budget check failed');
      return reply.code(500).send({ error: 'internal_error', message: 'Ошибка проверки AI-баланса. Попробуйте позже.' });
    }

    // Branch: multipart (with attachments) vs JSON (text-only).
    // Multipart parts are streamed before SSE headers go out — must finish
    // before we start writing to reply.raw.
    const isMultipart = typeof (req as any).isMultipart === 'function' && (req as any).isMultipart();
    type ChatBody = { conversationId?: number; message: string; shopId?: number; attachments: ValidatedAttachment[] };
    let body: ChatBody;
    if (isMultipart) {
      try {
        body = await parseMultipartChatRequest(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'multipart parse failed';
        return reply.code(400).send({ error: 'bad_request', message: msg });
      }
    } else {
      const parsed = z.object({
        conversationId: z.coerce.number().optional(),
        message: z.string().min(1).max(4000),
        shopId: z.coerce.number().int().positive().optional(),
      }).parse(req.body);
      body = { ...parsed, attachments: [] };
    }

    // shopId: body has priority, fallback to query (apiFetch auto-injects from store)
    const effectiveShopId = body.shopId ?? queryParams.shopId ?? null;

    // Validate shopId belongs to this workspace (prevent cross-workspace shop access)
    if (effectiveShopId) {
      const [validShop] = await db
        .select({ shopId: marketplaceShops.shopId })
        .from(marketplaceShops)
        .where(and(
          eq(marketplaceShops.shopId, effectiveShopId),
          eq(marketplaceShops.workspaceId, wsId),
          eq(marketplaceShops.isActive, true),
        ))
        .limit(1);
      if (!validShop) {
        return reply.code(403).send({ error: 'Shop does not belong to this workspace' });
      }
    }

    // ── Slash-команды (2026-06-01) ──────────────────────────────────
    // Если сообщение начинается со «/», перехватываем его в command-executor:
    // выполняем напрямую без LLM. Это экономит токены, мгновенно отрабатывает
    // частые сценарии и даёт предсказуемый результат.
    if (body.message.trim().startsWith('/')) {
      const { parseCommand } = await import('../services/chatCommands/parser.js');
      const { executeCommand } = await import('../services/chatCommands/executor.js');
      const parsed = parseCommand(body.message);
      if (parsed) {
        const result = await executeCommand(parsed, {
          workspaceId: wsId,
          shopId: effectiveShopId ?? undefined,
          userId: userId ?? undefined,
        });
        // Отдаём результат в JSON (не SSE) — нет долгого стрима, ответ
        // готов мгновенно.
        return reply.send({
          ok: true,
          command: parsed.spec.name,
          result,
        });
      }
    }

    // Track SSE connection
    const connId = trackConnection(userId);
    if (!connId) {
      return reply.code(429).send({ error: 'Too many concurrent AI connections' });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Clean up SSE connection tracking if client disconnects early
    let clientDisconnected = false;
    req.raw.on('close', () => {
      clientDisconnected = true;
      releaseConnection(userId, connId);
    });

    try {
      // Get or create conversation
      let convId = body.conversationId;
      let threadId: string;

      // shopIdForGraph: from CONVERSATION for existing chats, from request for new chats
      let shopIdForGraph: number | null = null;

      if (convId) {
        const [conv] = await db
          .select()
          .from(agentConversations)
          .where(and(eq(agentConversations.conversationId, convId), eq(agentConversations.workspaceId, wsId)))
          .limit(1);
        if (!conv) {
          reply.raw.write(sseEvent('error', { message: 'Conversation not found' }));
          reply.raw.end();
          return;
        }
        threadId = conv.threadId!;
        // Existing conversation: ALWAYS use conversation's shopId (locked at creation)
        shopIdForGraph = conv.shopId;

        // Verify conversation's shop still belongs to this workspace
        if (shopIdForGraph) {
          const [validShop] = await db
            .select({ shopId: marketplaceShops.shopId })
            .from(marketplaceShops)
            .where(and(
              eq(marketplaceShops.shopId, shopIdForGraph),
              eq(marketplaceShops.workspaceId, wsId),
            ))
            .limit(1);
          if (!validShop) {
            reply.raw.write(sseEvent('error', { message: 'Магазин этого чата больше не доступен.' }));
            reply.raw.end();
            releaseConnection(userId, connId);
            return;
          }
        }
      } else {
        // M3: prefix thread_id with `ws-<workspaceId>-` so the shared
        // PostgresSaver checkpoint table can't be cross-tenant addressed
        // by a guessed/leaked UUID. UUID collisions are astronomically
        // unlikely (2^122 space) but defence in depth costs nothing here.
        threadId = `ws-${wsId}-${crypto.randomUUID()}`;
        shopIdForGraph = effectiveShopId;
        const [conv] = await db.insert(agentConversations).values({
          workspaceId: wsId,
          userId,
          shopId: shopIdForGraph ?? null,
          threadId,
          title: body.message.slice(0, 100),
        }).returning();
        convId = conv.conversationId;
      }

      // Guard: shopId must be set — prevents querying ALL shops
      if (!shopIdForGraph) {
        reply.raw.write(sseEvent('error', { message: 'Выберите магазин для начала анализа.' }));
        reply.raw.end();
        releaseConnection(userId, connId);
        return;
      }

      // Save user message ONLY for text-only turns. Multimodal runner persists
      // user message itself (with attachments meta) inside its own pipeline.
      if (body.attachments.length === 0) {
        await db.insert(agentMessages).values({
          conversationId: convId,
          role: 'user',
          content: body.message,
        });
      }

      // Send conversation ID to client (include shopId so frontend can show badge)
      reply.raw.write(sseEvent('conversation', { conversationId: convId, threadId, shopId: shopIdForGraph }));

      // Build prompt context with conversation's shopId
      const promptContext = await buildPromptContext(wsId, shopIdForGraph ?? undefined);

      // ── Multimodal branch: bypass LangGraph for turns with file attachments.
      // langchain-anthropic 1.3.x silently drops image/file content blocks
      // (issues langchain-js #9851 #9877), so we use raw @anthropic-ai/sdk.
      // Tools, system prompt, and risk/confirm flow are reused unchanged.
      if (body.attachments.length > 0) {
        try {
          const result = await runMultimodalTurn(
            {
              workspaceId: wsId,
              shopId: shopIdForGraph,
              userId,
              threadId,
              conversationId: convId!,
              userText: body.message,
              attachments: body.attachments,
              promptContext,
            },
            {
              onText: (chunk) => reply.raw.write(sseEvent('text', { content: chunk })),
              onStatus: (text) => reply.raw.write(sseEvent('status', { text })),
              onInterrupt: (payload) => {
                reply.raw.write(sseEvent('interrupt', { ...payload, resumeToken: threadId }));
              },
              onAttachmentsSaved: (saved) => {
                reply.raw.write(sseEvent('attachments', { attachments: saved }));
              },
              onUsage: (input, output) => {
                // deduction handled by aiTokens service via existing langchain
                // path; for multimodal we log usage and let a follow-up service
                // hook deduct in one place. For now: include in SSE for UI debug.
                reply.raw.write(sseEvent('usage', { input, output }));
              },
            },
          );
          // Bill the workspace for this turn (mirrors the langchain path).
          try {
            const { deductUsage } = await import('../services/aiTokens.js');
            await deductUsage({
              workspaceId: wsId,
              userId: userId ?? 0,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              model: 'claude-sonnet-4-6',
            });
          } catch (billErr) {
            req.log.error({ err: billErr }, 'multimodal billing failed (non-fatal)');
          }
          await db.update(agentConversations).set({ updatedAt: new Date() }).where(eq(agentConversations.conversationId, convId));
          reply.raw.write(sseEvent('done', { conversationId: convId }));
        } catch (mmErr) {
          const message = mmErr instanceof Error ? mmErr.message : 'multimodal turn failed';
          req.log.error({ err: mmErr }, 'multimodal turn failed');
          reply.raw.write(sseEvent('error', { message }));
        } finally {
          if (!clientDisconnected) releaseConnection(userId, connId);
          reply.raw.end();
        }
        return;
      }

      // Stream agent execution
      const graph = await getGraph();
      reply.raw.write(sseEvent('status', { text: '🔍 Анализирую...' }));

      // Defense-in-depth: if this thread is paused at a confirm interrupt,
      // treat the incoming message as the user's decision and resume via
      // Command({ resume }) instead of starting a fresh turn. Without this,
      // a plain "да" typed into the input (rather than the inline button)
      // would land in agentNode and lose the pendingAction context.
      const threadState = await graph.getState({ configurable: { thread_id: threadId } });
      const isPendingInterrupt =
        Boolean(threadState?.tasks?.some((t: any) => (t?.interrupts?.length ?? 0) > 0)) &&
        Boolean((threadState?.values as any)?.pendingAction);

      const streamInput: Parameters<typeof graph.stream>[0] = isPendingInterrupt
        ? new Command({ resume: body.message })
        : {
            messages: [new HumanMessage(body.message)],
            workspaceId: wsId,
            userId,
            shopId: shopIdForGraph,
            promptContext,
            sseEventCounter: 0,
          };

      const stream = await graph.stream(
        streamInput,
        {
          configurable: { thread_id: threadId },
          streamMode: 'updates',
          recursionLimit: 40,
        }
      );

      for await (const chunk of stream) {
        for (const [nodeName, update] of Object.entries(chunk)) {
          const u = update as any;

          if (u.messages) {
            for (const msg of u.messages) {
              const msgType = msg._getType?.() ?? msg.constructor?.name ?? 'unknown';

              if (msgType === 'ai') {
                const content = typeof msg.content === 'string' ? msg.content : '';

                // Check for tool calls
                if (msg.tool_calls?.length) {
                  for (const tc of msg.tool_calls) {
                    // Mask tool name for client (security)
                    reply.raw.write(sseEvent('status', { text: '⚙️ Обрабатываю данные...' }));
                  }
                }

                // Text response
                if (content) {
                  reply.raw.write(sseEvent('text', { content }));

                  // Save assistant message
                  await db.insert(agentMessages).values({
                    conversationId: convId!,
                    role: 'assistant',
                    content,
                    toolCalls: msg.tool_calls?.length ? msg.tool_calls : undefined,
                  });
                  // rev 27M.2: mirror back into Telegram when applicable.
                  await pushAssistantToTelegramIfBotConv(convId!, content);
                }
              }

              if (msgType === 'tool') {
                const toolContent = typeof msg.content === 'string' ? msg.content : '';

                // Check for widget / attachments payload
                try {
                  const parsed = JSON.parse(toolContent);
                  if (parsed.__widget) {
                    reply.raw.write(sseEvent('widget', {
                      type: parsed.__widget,
                      props: parsed.props,
                    }));

                    // Save widget message
                    await db.insert(agentMessages).values({
                      conversationId: convId!,
                      role: 'assistant',
                      widgetType: parsed.__widget,
                      widgetProps: parsed.props,
                    });
                  }
                  // Attachments payload (e.g. supply slip PDF из action_generate_supply_slip).
                  // Schema: { __attachments: [{ url, fileName, mime, sizeBytes }], content?: string }
                  if (parsed.__attachments && Array.isArray(parsed.__attachments) && parsed.__attachments.length > 0) {
                    const attachments = parsed.__attachments
                      .filter((a: unknown): a is { url: string; fileName: string; mime: string; sizeBytes?: number } => {
                        return !!a && typeof (a as { url?: unknown }).url === 'string'
                          && typeof (a as { fileName?: unknown }).fileName === 'string'
                          && typeof (a as { mime?: unknown }).mime === 'string';
                      });
                    if (attachments.length > 0) {
                      reply.raw.write(sseEvent('attachment', { attachments }));
                      await db.insert(agentMessages).values({
                        conversationId: convId!,
                        role: 'assistant',
                        content: typeof parsed.content === 'string' ? parsed.content : null,
                        attachments,
                      });
                    }
                  }
                } catch {
                  // Not JSON / not a widget — just tool result, continue
                }
              }
            }
          }

          // Check for interrupt (human-in-the-loop)
          if (u.pendingAction) {
            reply.raw.write(sseEvent('interrupt', {
              action: u.pendingAction.toolName,
              args: u.pendingAction.toolArgs,
              rationale: u.pendingAction.rationale,
              resumeToken: `${threadId}`,
            }));

            // Track interrupt timestamp for timeout cleanup
            await db.update(agentConversations)
              .set({ meta: { interruptedAt: new Date().toISOString() } })
              .where(eq(agentConversations.conversationId, convId));
          }
        }
      }

      // Update conversation timestamp
      await db.update(agentConversations)
        .set({ updatedAt: new Date() })
        .where(eq(agentConversations.conversationId, convId));

      reply.raw.write(sseEvent('done', { conversationId: convId }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      reply.raw.write(sseEvent('error', { message }));
    } finally {
      if (!clientDisconnected) releaseConnection(userId, connId);
      reply.raw.end();
    }
  });

  /**
   * POST /ai/chat/resume — Resume after interrupt (confirmation/rejection).
   */
  app.post('/ai/chat/resume', {
    preHandler: requireRole('viewer'),
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => `ai-resume:${req.user?.userId ?? req.ip}`,
      },
    },
  }, async (req, reply) => {
    const sseEvent = createSseEmitter();
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const userId: number | null = (req as any).user?.userId ?? null;

    const body = z.object({
      threadId: z.string(),
      conversationId: z.coerce.number(),
      decision: z.enum(['approve', 'reject']),
      note: z.string().optional(),
    }).parse(req.body);

    // Verify conversation belongs to workspace
    const [conv] = await db
      .select()
      .from(agentConversations)
      .where(and(
        eq(agentConversations.conversationId, body.conversationId),
        eq(agentConversations.workspaceId, wsId),
      ))
      .limit(1);

    if (!conv) return reply.code(404).send({ error: 'Conversation not found' });

    const connId = trackConnection(userId);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const graph = await getGraph();
      const promptContext = await buildPromptContext(wsId, conv.shopId ?? undefined);

      const resumeMessage = body.decision === 'approve'
        ? `Подтверждаю. ${body.note ?? ''}`
        : `Отменяю. ${body.note ?? ''}`;

      const stream = await graph.stream(
        new Command({ resume: resumeMessage }),
        {
          configurable: { thread_id: body.threadId },
          streamMode: 'updates',
          recursionLimit: 40,
        }
      );

      for await (const chunk of stream) {
        for (const [, update] of Object.entries(chunk)) {
          const u = update as any;
          if (u.messages) {
            for (const msg of u.messages) {
              const msgType = msg._getType?.() ?? 'unknown';
              if (msgType === 'ai' && typeof msg.content === 'string' && msg.content) {
                reply.raw.write(sseEvent('text', { content: msg.content }));
                await db.insert(agentMessages).values({
                  conversationId: body.conversationId,
                  role: 'assistant',
                  content: msg.content,
                });
                // rev 27M.2: mirror back into Telegram when applicable.
                await pushAssistantToTelegramIfBotConv(body.conversationId, msg.content);
              }
            }
          }
        }
      }

      reply.raw.write(sseEvent('done', { conversationId: body.conversationId }));
    } catch (err) {
      reply.raw.write(sseEvent('error', { message: err instanceof Error ? err.message : 'Resume error' }));
    } finally {
      if (connId) releaseConnection(userId, connId);
      reply.raw.end();
    }
  });

  /**
   * GET /ai/conversations — List user's conversations.
   */
  app.get('/ai/conversations', { preHandler: requireRole('viewer') }, async (req) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);

    // Show ALL conversations (no shopId filter) — frontend shows shop badges.
    // rev 27M.1: include `meta` so the frontend can render an "📱 Из Telegram"
    // badge for telegram-source conversations.
    const convs = await db
      .select({
        conversationId: agentConversations.conversationId,
        shopId: agentConversations.shopId,
        shopName: marketplaceShops.name,
        title: agentConversations.title,
        agentType: agentConversations.agentType,
        status: agentConversations.status,
        createdAt: agentConversations.createdAt,
        updatedAt: agentConversations.updatedAt,
        meta: agentConversations.meta,
      })
      .from(agentConversations)
      .leftJoin(marketplaceShops, eq(agentConversations.shopId, marketplaceShops.shopId))
      .where(and(eq(agentConversations.workspaceId, wsId), eq(agentConversations.status, 'active')))
      .orderBy(desc(agentConversations.updatedAt))
      .limit(50);

    return { conversations: convs };
  });

  /**
   * GET /ai/conversations/:id — Get conversation with messages.
   */
  app.get('/ai/conversations/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const convId = Number((req.params as any).id);

    const [conv] = await db
      .select()
      .from(agentConversations)
      .where(and(eq(agentConversations.conversationId, convId), eq(agentConversations.workspaceId, wsId)))
      .limit(1);

    if (!conv) return reply.code(404).send({ error: 'Not found' });

    const messages = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, convId))
      .orderBy(agentMessages.createdAt);

    return {
      conversation: conv,
      messages: messages.map((m) => ({
        id: m.messageId,
        role: m.role,
        content: m.content,
        widgetType: m.widgetType,
        widgetProps: m.widgetProps,
        createdAt: m.createdAt,
      })),
    };
  });

  /**
   * DELETE /ai/conversations/:id — Archive conversation.
   */
  app.delete('/ai/conversations/:id', { preHandler: requireRole('viewer') }, async (req, reply) => {
    const { workspaceId: wsId } = z.object({ workspaceId: z.coerce.number().int().positive() }).parse(req.query);
    const convId = Number((req.params as any).id);

    await db
      .update(agentConversations)
      .set({ status: 'archived' })
      .where(and(eq(agentConversations.conversationId, convId), eq(agentConversations.workspaceId, wsId)));

    return { ok: true };
  });

  // ── Slash-команды: autocomplete + список (2026-06-01) ──────────
  // Frontend дёргает при вводе «/» в чат-инпуте, чтобы показать dropdown.
  app.get('/ai/chat/commands', { preHandler: requireRole('viewer') }, async (req) => {
    const query = z.object({
      prefix: z.string().optional(),
      category: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }).parse((req as any).query ?? {});

    const { COMMANDS, suggestCommands, listByCategory } = await import('../services/chatCommands/registry.js');

    if (query.prefix !== undefined) {
      const matches = suggestCommands(query.prefix, query.limit ?? 8);
      return {
        prefix: query.prefix,
        matches: matches.map((c) => ({
          name: c.name,
          aliases: c.aliases ?? [],
          category: c.category,
          description: c.description,
          requiresConfirm: c.requiresConfirm ?? false,
          args: c.args.map((a) => ({ name: a.name, type: a.type, optional: a.optional ?? false, hint: a.hint })),
        })),
      };
    }

    if (query.category) {
      const list = (listByCategory() as any)[query.category] ?? [];
      return { category: query.category, commands: list };
    }

    return {
      total: COMMANDS.length,
      categories: listByCategory(),
    };
  });
};

// ── Helpers ────────────────────────────────────────────────

async function buildPromptContext(wsId: number, shopId?: number): Promise<PromptContext> {
  // Workspace name
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.workspaceId, wsId)).limit(1);

  // Shop names
  const shops = await db
    .select({ shopId: marketplaceShops.shopId, name: marketplaceShops.name })
    .from(marketplaceShops)
    .where(eq(marketplaceShops.workspaceId, wsId));

  // Current shop context
  let currentShopName: string | undefined;
  let currentShopId: number | undefined;
  if (shopId) {
    const shop = shops.find(s => s.shopId === shopId);
    currentShopName = shop?.name ?? undefined;
    currentShopId = shopId;
  }

  // Alert thresholds
  const [alerts] = await db.select().from(wbAlertSettings).where(eq(wbAlertSettings.workspaceId, wsId)).limit(1);

  // Agent settings
  const [settings] = await db.select().from(agentSettings).where(eq(agentSettings.workspaceId, wsId)).limit(1);

  return {
    workspaceName: ws?.name ?? undefined,
    shopNames: shops.map((s) => s.name).filter(Boolean) as string[],
    currentShopId,
    currentShopName,
    alertThresholds: alerts
      ? {
          maxDrrPct: alerts.maxDrrFactPct ?? undefined,
          minDaysOfStock: alerts.minDaysOfStock ?? undefined,
          buyoutDropWarn: alerts.buyoutDropPpWarn ?? undefined,
        }
      : undefined,
    agentSettings: settings
      ? {
          autoReplyPositive: settings.autoReplyPositive ?? false,
          autoPriceProtectOos: settings.autoPriceProtectOos ?? false,
          maxPriceChangePct: settings.maxPriceChangePct ?? 10,
          minMarginPct: settings.minMarginPct ?? undefined,
        }
      : undefined,
    currentDate: new Date().toISOString().slice(0, 10),
  };
}
