/**
 * Zod-схемы для V5 Council. Источник истины для output каждого агента
 * и финального JSON. Любое отклонение от схемы валится при парсинге
 * и Claude вызывается заново (см. orchestrator).
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────
// SHARED PRIMITIVES
// ────────────────────────────────────────────────────────────────

export const PriorityEnum = z.enum(['critical', 'high', 'medium', 'low']);
export const PerceivedSegmentEnum = z.enum(['дешёвый', 'средний', 'премиум']);
export const QualityVsPriceEnum = z.enum(['выше_цены', 'соответствует', 'ниже_цены']);
export const RiskLevelEnum = z.enum(['критичный', 'высокий', 'средний', 'низкий']);
export const LiftEnum = z.enum(['крупный', 'средний', 'малый']);
export const SpamDensityEnum = z.enum(['норм', 'повышен', 'критичен']);
export const FrequencyEnum = z.enum(['ВЧ', 'СЧ', 'НЧ']);
export const ExpectedImpactEnum = z.enum(['high', 'medium', 'low']);

// Жёсткий enum типов кадров (только русский, без английских эквивалентов).
// 14 типов: 11 базовых + 3 добавлены после council-ревью (rev1):
//   - "сертификат" — отдельный сигнал доверия в детских/косметике/БАДах
//   - "сравнение с конкурентом" — это не то же, что "сравнение цветов"
//   - "отзыв-цитата" — крупная цитата отзыва на слайде (частый паттерн WB)
export const PhotoTypeEnum = z.enum([
  'главное фото',
  'инфографика',
  'образ жизни',
  'детали материала',
  'размеры и масштаб',
  'в использовании',
  'упаковка',
  'сравнение цветов',
  'размерная сетка',
  'до и после',
  'видео-кадр',
  'сертификат',
  'сравнение с конкурентом',
  'отзыв-цитата',
]);

const Score = z.number().min(0).max(100);

// ────────────────────────────────────────────────────────────────
// TextAgent OUTPUT
// ────────────────────────────────────────────────────────────────

export const TextAgentOutput = z.object({
  seoAnalysis: z.object({
    seoStrength: Score,
    titleAnalysis: z.object({
      currentLength: z.number().int().nonnegative(),
      currentKeywords: z.array(z.string()),
      issues: z.array(z.string()),
      score: Score,
    }),
    titleKeywords: z.object({
      found: z.array(z.string()),
      missing: z.array(z.string()),
      spam: z.array(z.string()),
    }),
    descriptionKeywords: z.object({
      found: z.array(z.string()),
      missing: z.array(z.string()),
      spamDensity: SpamDensityEnum,
    }),
    recommendedKeywords: z.array(
      z.object({
        keyword: z.string(),
        frequency: FrequencyEnum,
        whereToAdd: z.string(),
      }),
    ),
    characteristicViolations: z.array(z.string()),
    algorithmicMechanism: z.string(),
  }),
  contentRewrites: z.object({
    suggestedTitle: z.string().max(60),
    suggestedTitleReasoning: z.string(),
    suggestedDescription: z.object({
      hook: z.string().max(400),
      body: z.string().max(4000),
      cta: z.string().max(200),
    }),
    totalLength: z.number().int().nonnegative(),
    characteristicsToAdd: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        why: z.string(),
      }),
    ),
  }),
  scores: z.object({
    seoStrength: Score,
    descriptionPersuasion: Score,
    benefitCommunication: Score,
    offerClarity: Score,
  }),
  confidence: Score,
  missingData: z.array(z.string()).default([]),
});

export type TextAgentOutputT = z.infer<typeof TextAgentOutput>;

// ────────────────────────────────────────────────────────────────
// VisualAgent OUTPUT
// ────────────────────────────────────────────────────────────────

const DesignerBriefPhoto = z.object({
  photoIndex: z.number().int().positive(),
  description: z.string(),
  type: PhotoTypeEnum,
  score: Score,
  strengths: z.array(z.string()),
  issues: z.array(z.string()),
  psychologicalImpact: z.string(),
  mobileReadability: z.string(),
  designerBrief: z.string(),
});

export const VisualAgentOutput = z.object({
  firstImage: z.object({
    score: Score,
    description: z.string(),
    attentionGrab: z.string(),
    offerClarity: z.string(),
    strengths: z.array(z.string()),
    issues: z.array(z.string()),
    conversionBarriers: z.array(z.string()),
    algorithmicMechanism: z.string(),
    designerBrief: z.string(),
  }),
  detailedPhotos: z.array(DesignerBriefPhoto),
  gallery: z.object({
    score: Score,
    currentSequenceLogic: z.string(),
    logicProblems: z.array(z.string()),
    recommendedSequence: z.array(
      z.object({
        position: z.number().int().positive(),
        type: PhotoTypeEnum,
        content: z.string(),
        why: z.string(),
      }),
    ),
    missingFrames: z.array(
      z.object({
        type: PhotoTypeEnum,
        description: z.string(),
        why: z.string(),
        designerBrief: z.string(),
      }),
    ),
  }),
  infographics: z.object({
    score: Score,
    strengths: z.array(z.string()),
    issues: z.array(z.string()),
    textReadabilityMobile: z.string(),
    dataToShow: z.array(z.string()),
  }),
  videoRecommendation: z.object({
    needed: z.boolean(),
    priority: z.enum(['высокий', 'средний', 'низкий']),
    content: z.string(),
    duration: z.string(),
    brief: z.string(),
  }),
  priceValueFit: z.object({
    perceivedQualityVsPrice: QualityVsPriceEnum,
    visualReasoning: z.string(),
  }),
  scores: z.object({
    firstImageStrength: Score,
    visualDifferentiation: Score,
    mobileReadability: Score,
    infographicQuality: Score,
    overallVisualQuality: Score,
  }),
  confidence: Score,
  missingData: z.array(z.string()).default([]),
});

export type VisualAgentOutputT = z.infer<typeof VisualAgentOutput>;

// ────────────────────────────────────────────────────────────────
// PsychologyAgent OUTPUT
// ────────────────────────────────────────────────────────────────

export const PsychologyAgentOutput = z.object({
  perceptionGap: z.object({
    sellerThinks: z.string(),
    buyerActuallyFeels: z.string(),
    mainDisconnect: z.string(),
    resultingBehavior: z.string(),
  }),
  buyerSimulation: z.object({
    first2Seconds: z.string(),
    firstEmotion: z.string(),
    firstQuestion: z.string(),
    momentOfDoubt: z.string(),
    reasonToLeave: z.string(),
    reasonToBuy: z.string(),
  }),
  pricingPsychology: z.object({
    pricePerception: z.string(),
    valueCommunicationGap: z.string(),
    howToJustifyCurrentPrice: z.string(),
  }),
  scores: z.object({
    trustSignals: Score,
    emotionalPersuasion: Score,
  }),
  confidence: Score,
});

export type PsychologyAgentOutputT = z.infer<typeof PsychologyAgentOutput>;

// ────────────────────────────────────────────────────────────────
// FINAL V5 OUTPUT (synthesizer)
// ────────────────────────────────────────────────────────────────

export const FinalAuditV5 = z.object({
  meta: z.object({
    nmId: z.number().int().positive(),
    subjectName: z.string().nullable(),
    auditVersion: z.literal('v5_council'),
    language: z.literal('ru'),
    timestamp: z.string(),
  }),
  overallScore: Score,
  cardScore: Score,
  photoScore: Score,
  confidence: Score,

  executiveSummary: z.string(),
  hardTruth: z.string(),
  hiddenOpportunity: z.string(),
  finalVerdict: z.string(),

  leveragePrinciple: z.object({
    rootProblem: z.string(),
    surfaceSymptoms: z.array(z.string()),
    highestRoiAction: z.string(),
  }),

  marketPosition: z.object({
    perceivedSegment: PerceivedSegmentEnum,
    perceivedQualityVsPrice: QualityVsPriceEnum,
    competitivePositioningSummary: z.string(),
  }),

  // Целиком из PsychologyAgent
  perceptionGap: PsychologyAgentOutput.shape.perceptionGap,
  buyerSimulation: PsychologyAgentOutput.shape.buyerSimulation,
  pricingPsychology: PsychologyAgentOutput.shape.pricingPsychology,

  scores: z.object({
    offerClarity: Score,
    firstImageStrength: Score,
    trustSignals: Score,
    seoStrength: Score,
    visualDifferentiation: Score,
    conversionReadiness: Score,
    emotionalPersuasion: Score,
    mobileReadability: Score,
    infographicQuality: Score,
    descriptionPersuasion: Score,
    benefitCommunication: Score,
    overallVisualQuality: Score,
  }),

  // Целиком из TextAgent
  seo: TextAgentOutput.shape.seoAnalysis,
  contentRewrites: TextAgentOutput.shape.contentRewrites,

  // Целиком из VisualAgent
  firstImage: VisualAgentOutput.shape.firstImage,
  detailedPhotos: VisualAgentOutput.shape.detailedPhotos,
  gallery: VisualAgentOutput.shape.gallery,
  infographics: VisualAgentOutput.shape.infographics,
  videoRecommendation: VisualAgentOutput.shape.videoRecommendation,

  topProblems: z
    .array(
      z.object({
        problem: z.string(),
        whyItKillsConversion: z.string(),
        whatBuyerFeels: z.string(),
        businessImpact: z.string(),
        algorithmicMechanism: z.string(),
        fix: z.string(),
        priority: PriorityEnum,
      }),
    )
    .max(5),

  quickWins: z
    .array(
      z.object({
        action: z.string(),
        timeMinutes: z.number().int().positive(),
        expectedImpact: z.string(),
      }),
    )
    .max(5),

  algorithmicImpact: z.object({
    summary: z.string(),
    categoryRetentionRisk: RiskLevelEnum,
    mechanismChains: z.array(z.string()),
  }),

  roleTasks: z.object({
    designer: z.array(
      z.object({
        task: z.string(),
        brief: z.string(),
        priority: PriorityEnum,
        timeEstimate: z.string(),
      }),
    ),
    contentManager: z.array(
      z.object({
        task: z.string(),
        brief: z.string(),
        priority: PriorityEnum,
        timeEstimate: z.string(),
      }),
    ),
    seoSpecialist: z.array(
      z.object({
        task: z.string(),
        brief: z.string(),
        priority: PriorityEnum,
        timeEstimate: z.string(),
      }),
    ),
    photographer: z.array(
      z.object({
        task: z.string(),
        brief: z.string(),
        priority: PriorityEnum,
        timeEstimate: z.string(),
      }),
    ),
    marketer: z.array(
      z.object({
        task: z.string(),
        brief: z.string(),
        priority: PriorityEnum,
        timeEstimate: z.string(),
      }),
    ),
  }),

  abTests: z.array(
    z.object({
      hypothesis: z.string(),
      variantA: z.string(),
      variantB: z.string(),
      metric: z.string(),
      expectedLift: LiftEnum,
    }),
  ),

  // Что было передано в Claude и какие агенты упали — для дебага
  __debug: z
    .object({
      agentsExecuted: z.array(z.string()),
      agentsFailed: z.array(z.string()),
      executionMs: z.number().int().nonnegative(),
    })
    .optional(),
});

export type FinalAuditV5T = z.infer<typeof FinalAuditV5>;
