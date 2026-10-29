/**
 * V5 Council Orchestrator.
 *
 * Layer 0: collectCardData (reuse из creativeAuditV3 — те же поля).
 * Layer 1: 3 параллельных агента (TextAgent, VisualAgent, PsychologyAgent).
 * Layer 2: CommercialSynthesizer — собирает финальный V5 JSON.
 *
 * Любой агент Layer 1 может упасть — synthesizer работает с тем что осталось,
 * но если упали ВСЕ три — кидаем ошибку (нет смысла собирать пустой аудит).
 */

import { collectCardData, type CardSnapshot } from '../creativeAuditV3.js';
import { runTextAgent } from './agents/textAgent.js';
import { runVisualAgent } from './agents/visualAgent.js';
import { runPsychologyAgent } from './agents/psychologyAgent.js';
import { runSynthesizer } from './agents/commercialSynthesizer.js';
import type { FinalAuditV5T } from './schemas.js';
import { db } from '../../db/client.js';
import { creativeAuditRunsFinal } from '../../db/schema.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'audit-council/orchestrator' });

export interface CouncilAuditResult {
  final: FinalAuditV5T;
  executionMs: number;
  agentsExecuted: string[];
  agentsFailed: string[];
  snapshot: CardSnapshot;
}

export async function runV5CouncilAudit(
  workspaceId: number,
  nmId: number,
): Promise<CouncilAuditResult> {
  const startedAt = Date.now();
  logger.info({ workspaceId, nmId }, 'V5 Council audit: start');

  // Layer 0 — данные карточки (тот же сборщик, что в v3)
  const snapshot = await collectCardData(workspaceId, nmId);
  const mainPhotoUrl = snapshot.photoUrls[0] ?? null;

  // Layer 1 — три агента параллельно
  const [textRes, visualRes, psychologyRes] = await Promise.allSettled([
    runTextAgent({
      nmId,
      workspaceId,
      title: snapshot.title,
      description: snapshot.description,
      characteristics: snapshot.characteristics,
      subjectName: snapshot.subjectName,
      brandName: snapshot.brandName,
      vendorCode: snapshot.vendorCode,
    }),
    runVisualAgent({
      nmId,
      workspaceId,
      title: snapshot.title,
      subjectName: snapshot.subjectName,
      brandName: snapshot.brandName,
      description: snapshot.description,
      photoUrls: snapshot.photoUrls,
    }),
    runPsychologyAgent({
      nmId,
      workspaceId,
      title: snapshot.title,
      description: snapshot.description,
      subjectName: snapshot.subjectName,
      brandName: snapshot.brandName,
      mainPhotoUrl,
    }),
  ]);

  const agentsExecuted: string[] = [];
  const agentsFailed: string[] = [];

  const text = textRes.status === 'fulfilled' ? textRes.value : null;
  if (text) agentsExecuted.push('text');
  else {
    agentsFailed.push('text');
    logger.error({ reason: (textRes as PromiseRejectedResult).reason }, 'TextAgent failed');
  }

  const visual = visualRes.status === 'fulfilled' ? visualRes.value : null;
  if (visual) agentsExecuted.push('visual');
  else {
    agentsFailed.push('visual');
    logger.error({ reason: (visualRes as PromiseRejectedResult).reason }, 'VisualAgent failed');
  }

  const psychology = psychologyRes.status === 'fulfilled' ? psychologyRes.value : null;
  if (psychology) agentsExecuted.push('psychology');
  else {
    agentsFailed.push('psychology');
    logger.error({ reason: (psychologyRes as PromiseRejectedResult).reason }, 'PsychologyAgent failed');
  }

  if (agentsFailed.length === 3) {
    throw new Error('All three specialist agents failed — aborting V5 audit');
  }

  // Layer 2 — синтезатор
  const final = await runSynthesizer({
    nmId,
    workspaceId,
    subjectName: snapshot.subjectName,
    text,
    visual,
    psychology,
    agentsFailed,
  });

  const executionMs = Date.now() - startedAt;
  logger.info(
    { workspaceId, nmId, executionMs, agentsExecuted, agentsFailed, overallScore: final.overallScore },
    'V5 Council audit: done',
  );

  // Прикрепляем debug-инфо для последующего сравнения с v3
  final.__debug = { agentsExecuted, agentsFailed, executionMs };

  return { final, executionMs, agentsExecuted, agentsFailed, snapshot };
}

/**
 * Wrapper, который ещё и сохраняет результат в creative_audit_runs_final
 * — drop-in замена для runFullAuditV3 в обработчике маршрута.
 */
export async function runFullV5CouncilAudit(
  workspaceId: number,
  nmId: number,
  opts?: { isFree?: boolean; shopId?: number | null },
): Promise<{ finalAudit: FinalAuditV5T; meta: { finalAuditId: number; snapshotId: null; executionMs: number; agentsFailed: string[] } }> {
  const result = await runV5CouncilAudit(workspaceId, nmId);

  // Persist (snapshot не сохраняем — V5 это не использует, snapshotId=null).
  const [row] = await db
    .insert(creativeAuditRunsFinal)
    .values({
      cardAuditId: 0,
      photoAuditId: 0,
      snapshotId: null,
      workspaceId,
      shopId: opts?.shopId ?? null,
      nmId,
      modelName: 'claude-sonnet-4-6',
      promptVersion: 'v5_council',
      isValidated: false,
      finalJson: result.final as any,
      overallScore: result.final.overallScore,
      cardScore: result.final.cardScore,
      photoScore: result.final.photoScore,
      confidence: result.final.confidence,
      isFree: opts?.isFree ?? true,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: '0',
    })
    .returning({ id: creativeAuditRunsFinal.id });

  logger.info(
    { workspaceId, nmId, finalAuditId: row.id, executionMs: result.executionMs, agentsFailed: result.agentsFailed },
    'V5 Council audit persisted',
  );

  return {
    finalAudit: result.final,
    meta: {
      finalAuditId: row.id,
      snapshotId: null,
      executionMs: result.executionMs,
      agentsFailed: result.agentsFailed,
    },
  };
}
