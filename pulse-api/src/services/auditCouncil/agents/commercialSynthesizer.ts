import { claudeChatJson } from '../../../integrations/ai/anthropic.js';
import {
  FinalAuditV5,
  type FinalAuditV5T,
  type TextAgentOutputT,
  type VisualAgentOutputT,
  type PsychologyAgentOutputT,
} from '../schemas.js';
import { SYNTHESIZER_SYSTEM_PROMPT } from '../prompts/synthesizerSystem.js';
import log from '../../../lib/logger.js';

const logger = log.child({ module: 'audit-council/synthesizer' });

export interface SynthesizerInput {
  nmId: number;
  workspaceId: number;
  subjectName: string | null;
  text: TextAgentOutputT | null;
  visual: VisualAgentOutputT | null;
  psychology: PsychologyAgentOutputT | null;
  agentsFailed: string[];
}

function buildUserPrompt(input: SynthesizerInput): string {
  const failed = input.agentsFailed.length ? `\n\nВНИМАНИЕ: упали следующие агенты (используй пустые блоки в их зонах, не выдумывай): ${input.agentsFailed.join(', ')}` : '';

  return `Ты получаешь выходы трёх специалистов. Собери финальный V5 аудит.

КАРТОЧКА: nmId=${input.nmId}, subjectName="${input.subjectName ?? ''}".

═══ TextAgent OUTPUT ═══
${input.text ? JSON.stringify(input.text, null, 2) : '(агент не отработал)'}

═══ VisualAgent OUTPUT ═══
${input.visual ? JSON.stringify(input.visual, null, 2) : '(агент не отработал)'}

═══ PsychologyAgent OUTPUT ═══
${input.psychology ? JSON.stringify(input.psychology, null, 2) : '(агент не отработал)'}${failed}

═══ ИНСТРУКЦИИ ═══

1) Блоки специалистов ПЕРЕДАВАЙ ЦЕЛИКОМ в финал:
   - text.seoAnalysis → final.seo
   - text.contentRewrites → final.contentRewrites
   - visual.firstImage → final.firstImage
   - visual.detailedPhotos → final.detailedPhotos (как есть)
   - visual.gallery → final.gallery (как есть)
   - visual.infographics → final.infographics
   - visual.videoRecommendation → final.videoRecommendation
   - psychology.perceptionGap → final.perceptionGap
   - psychology.buyerSimulation → final.buyerSimulation
   - psychology.pricingPsychology → final.pricingPsychology

2) marketPosition.perceivedQualityVsPrice — бери из visual.priceValueFit.perceivedQualityVsPrice.

3) ТВОЯ собственная работа:
   - executiveSummary, hardTruth, hiddenOpportunity, finalVerdict
   - leveragePrinciple (rootProblem, surfaceSymptoms, highestRoiAction)
   - marketPosition.perceivedSegment (по metadata)
   - marketPosition.competitivePositioningSummary
   - topProblems[<=5] — 80/20 из всех issues агентов, каждый с
     algorithmicMechanism (цепочка из 4 звеньев)
   - quickWins[<=5] (<= 15 минут)
   - algorithmicImpact (summary, categoryRetentionRisk, mechanismChains)
   - roleTasks (designer, contentManager, seoSpecialist, photographer, marketer)
   - abTests
   - scores (см. формулу в systemPrompt — рассчитай и пропиши конкретные числа)
   - overallScore, cardScore, photoScore, confidence по формулам

4) meta {nmId, subjectName, auditVersion: "v5_council", language: "ru", timestamp: "${new Date().toISOString()}"}.

5) Ответ — только JSON, начинаешь с { заканчиваешь }.`;
}

export async function runSynthesizer(input: SynthesizerInput): Promise<FinalAuditV5T> {
  logger.info(
    {
      nmId: input.nmId,
      hasText: !!input.text,
      hasVisual: !!input.visual,
      hasPsychology: !!input.psychology,
      failed: input.agentsFailed,
    },
    'Synthesizer: start',
  );

  const userPrompt = buildUserPrompt(input);

  const result = await claudeChatJson<unknown>(
    [
      { role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.2,
      model: 'claude-sonnet-4-6',
      // Synthesizer output — самый большой (final V5 schema ≈ 8-10k токенов)
      maxTokens: 16384,
      meta: {
        workspaceId: input.workspaceId,
        feature: 'audit-council-synthesizer',
        itemType: 'wb_card',
        itemId: String(input.nmId),
        charge: true,
      },
    },
  );

  // Zod-валидация. Жёсткая — если что-то не так, мы хотим знать.
  const parsed = FinalAuditV5.safeParse(result.data);
  if (!parsed.success) {
    logger.error(
      { nmId: input.nmId, errors: parsed.error.flatten() },
      'Synthesizer: invalid final JSON',
    );
    throw new Error(
      `Synthesizer output failed Zod validation: ${JSON.stringify(parsed.error.flatten()).slice(0, 500)}`,
    );
  }

  logger.info(
    {
      nmId: input.nmId,
      overallScore: parsed.data.overallScore,
      cardScore: parsed.data.cardScore,
      photoScore: parsed.data.photoScore,
    },
    'Synthesizer: done',
  );

  return parsed.data;
}
