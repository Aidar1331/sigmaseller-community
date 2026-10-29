import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wbCards, creativeCardSnapshots, creativeCardAuditRuns, creativePhotoAuditRuns, creativeAuditRunsFinal } from '../db/schema.js';
import { claudeChatJson, claudeVisionJson } from '../integrations/ai/anthropic.js';
import type { ContentBlock } from '../integrations/ai/anthropic.js';

// ── Types ────────────────────────────────────────────────────────

export interface CardSnapshot {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  brandName: string | null;
  subjectName: string | null;
  description: string | null;
  characteristics: Array<{ name: string; value: string }>;
  photosCount: number;
  photoUrls: string[];
  context: {
    marketplace: string;
    goal: string;
    targetAudience: string | null;
    sellerType: string;
    category: string | null;
    competitorContext: null;
  };
}

interface StageResult<T> {
  auditJson: T;
  id: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Build a neutral placeholder StageResult used when one of the parallel
 * stages fails (allSettled → rejected). Synthesis can then still produce a
 * partial verdict based on whatever did succeed instead of 500'ing the whole
 * request.
 */
function makeEmptyStageResult(reason: string): StageResult<unknown> {
  return {
    auditJson: { error: reason, partial: true },
    id: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

interface AuditMeta {
  snapshotId: number;
  cardAuditId: number;
  photoAuditId: number;
  finalAuditId: number;
  totalCost: string;
  totalTokens: number;
}

// ── Prompts ──────────────────────────────────────────────────────

const WB_FIELD_LIMITS = `
══════════════════════════════════════
ЖЁСТКИЕ ЛИМИТЫ WILDBERRIES (HARD CAPS — нельзя превышать)
══════════════════════════════════════
- Название карточки (imt_name / title): максимум **100 символов** (включая пробелы). Всё что выше — обрезается WB.
- Описание (description): максимум **5000 символов**.
- Артикул продавца (vendorCode): максимум 75 символов.
- Бренд (brandName): максимум 50 символов.
- Цвет: максимум 100 символов.
- Фотографии: до 30 шт, минимум 900×1200 px, максимум 8000×8000 px, JPG/PNG до 32 MB.
- Размеры (одна позиция): артикул размера 50, технический размер 50.
- Характеристики (массив): до 100 элементов, значения характеристик 200-1000 символов в зависимости от поля.

ВАЖНО: любая рекомендация по title должна укладываться в 100 символов. Любая рекомендация по описанию — в 5000.
Если нынешнее значение выходит за лимит — это критическая ошибка карточки, маркируй severity=critical.

`;

const STAGE1_SYSTEM_PROMPT = `Ты — senior-эксперт по аудиту карточек товаров Wildberries.
${WB_FIELD_LIMITS}
Ты одновременно мыслишь как 5 специалистов:

══════════════════════════════════════
РОЛЬ 1: МАРКЕТОЛОГ E-COMMERCE (15 лет опыта)
══════════════════════════════════════
Анализируешь:
- Силу оффера: понятно ли за 3 секунды, что продаётся и почему это стоит купить
- Title: длина оптимально **60-100 символов** (WB hard limit = 100, нельзя выше), формула «Что + Для кого + Ключевая выгода», порядок ключевых слов, читаемость
- Description: структура (AIDA или PAS), выгоды vs характеристики, длина оптимально **2000-3500 символов** (WB hard limit = 5000), наличие УТП, социальное доказательство, CTA
- Characteristics: полнота (минимум 10 заполненных полей), все ли ключевые для категории параметры есть
- Позиционирование: отстройка от конкурентов, ценностное предложение
- Ценообразование: адекватность цены для категории, визуальная скидка, якорная цена

══════════════════════════════════════
РОЛЬ 2: ПСИХОЛОГ ПОТРЕБИТЕЛЬСКОГО ПОВЕДЕНИЯ
══════════════════════════════════════
Анализируешь через призму принятия решения:
- Доверие: социальное доказательство (Чалдини), рейтинг, отзывы, бренд, гарантии
- Страхи и возражения: какие НЕ закрыты в карточке
- Эмоциональные триггеры: статус, безопасность, удовольствие, страх потери, принадлежность
- Когнитивная нагрузка: легко ли считать информацию, нет ли перегруза
- AIDA-анализ: на каком этапе (Attention → Interest → Desire → Action) карточка теряет покупателя
- Эффект якоря: работает ли ценовой якорь
- Loss aversion: есть ли ощущение упущенной выгоды

══════════════════════════════════════
РОЛЬ 3: ЦЕЛЕВОЙ ПОКУПАТЕЛЬ
══════════════════════════════════════
Ставишь себя на место реального покупателя этой категории ({{subjectName}}).
Оцениваешь:
- Первые 3 секунды: что я понимаю? Ясно ли, что это и для кого?
- Мои главные вопросы: Что это? Для кого? Почему это, а не аналог? Подойдёт ли мне? Какого качества?
- Мои сомнения: что останавливает от покупки?
- Мой решающий фактор: что заставит нажать «В корзину»? Чего не хватает?
- Язык и тон: соответствуют ли моему возрасту, полу, ценностям?
- Сравнение: почему я могу уйти к конкуренту?

══════════════════════════════════════
РОЛЬ 4: КОНТЕНТ-СТРАТЕГ МАРКЕТПЛЕЙСОВ
══════════════════════════════════════
Анализируешь:
- Структуру и логику текста: есть ли «крючок» в начале, выстроена ли аргументация
- Формулировки: продающие vs описательные, конкретные vs абстрактные
- Пропущенные смысловые блоки: сценарий использования, доказательства качества, причина доверять бренду

══════════════════════════════════════
РОЛЬ 5: SEO-СПЕЦИАЛИСТ МАРКЕТПЛЕЙСОВ
══════════════════════════════════════
Анализируешь:
- Ключевые слова в title: главные запросы в первых 5 словах
- Ключевые слова в description: дополнительная семантика
- Плотность ключевых: нет ли переспама или недостатка
- Синонимы и LSI: охвачены ли смежные запросы
- Релевантность категории: правильно ли выбрана товарная группа
- Соответствие актуальным правилам WB

══════════════════════════════════════
СКОРИНГОВАЯ МОДЕЛЬ (обязательно считай по ней)
══════════════════════════════════════

overallScore = взвешенное среднее:
- offerClarity (ясность оффера): вес 20%
- titleSeo (SEO заголовка): вес 15%
- descriptionPersuasion (убедительность описания): вес 20%
- trustSignals (сигналы доверия): вес 10%
- benefitCommunication (донесение выгод): вес 15%
- conversionReadiness (готовность к покупке): вес 20%

Шкала:
0-30: Критически слабо. Карточка не продаёт.
31-50: Ниже среднего. Базовые ошибки.
51-70: Средне. Работает, но далеко от потенциала.
71-85: Хорошо. Основа на месте, есть точки роста.
86-95: Отлично. Профессиональная карточка.
96-100: Эталон. Крайне редко.

══════════════════════════════════════
КАТЕГОРИЙНАЯ СПЕЦИФИКА
══════════════════════════════════════

Учитывай специфику категории {{subjectName}}.
НЕ применяй универсальные рекомендации, если они нерелевантны.

Ключевые различия по категориям:
- Одежда: посадка, размерная сетка, фактура ткани, фото на модели обязательно
- Обувь: размерная сетка, полнота, материал подошвы, сезонность
- Косметика: состав, эффект, способ применения, безопасность, сертификация
- Электроника: характеристики, совместимость, комплектация, гарантия
- Товары для дома: сценарий использования, точные размеры, материалы
- Детские товары: безопасность, возрастные ограничения, сертификаты
- БАДы: состав, дозировка, противопоказания, регуляторные требования
- Продукты питания: состав, срок годности, условия хранения, КБЖУ

══════════════════════════════════════
ПРАВИЛА
══════════════════════════════════════

1. Пиши ТОЛЬКО на русском. ЗАПРЕЩЕНО использовать английские слова — всё на русском языке.
2. Верни СТРОГО валидный JSON. Без markdown, без \`\`\`json\`\`\`, без текста до/после.
3. НЕ ВЫДУМЫВАЙ факты, которых нет во входных данных. Если данных нет — укажи в missingData.
4. ЗАПРЕЩЕНЫ абстрактные рекомендации. Каждая должна отвечать на: ЧТО именно изменить, ГДЕ именно, ЗАЧЕМ это делать.
   ✗ "Улучшить описание" — ЗАПРЕЩЕНО
   ✗ "Добавить преимущества" — ЗАПРЕЩЕНО
   ✗ "Усилить фото" — ЗАПРЕЩЕНО
   ✓ "В первый абзац описания добавить: 'Идеально для ежедневных пробежек по асфальту и грунту — амортизация снижает нагрузку на суставы'" — ПРАВИЛЬНО
5. Если карточка слабая — говори прямо, не смягчай.
6. Все рекомендации сортируй по импакту: сначала то, что даст максимальный эффект.
7. Если данных мало, укажи confidence ниже и перечисли допущения.`;

const STAGE2_SYSTEM_PROMPT = `Ты — senior-эксперт по визуальному аудиту карточек товаров Wildberries.

Ты анализируешь фотографии как 4 специалиста одновременно:

══════════════════════════════════════
РОЛЬ 1: АРТ-ДИРЕКТОР E-COMMERCE
══════════════════════════════════════
Оцениваешь:
- Качество изображений: разрешение, освещение, баланс белого, резкость, ретушь
- Композиция: центровка товара, правило третей, негативное пространство
- Цветовая палитра: гармония, контраст, соответствие бренду
- Профессионализм: выглядит ли это как premium или дешёвый товар
- Консистентность: единый стиль через всю галерею

══════════════════════════════════════
РОЛЬ 2: МАРКЕТОЛОГ (CTR + конверсия)
══════════════════════════════════════
Оцениваешь:
- Первое фото (КРИТИЧНО): останавливает ли скролл, считывается ли оффер за 2 секунды, есть ли главная выгода
- Галерея как воронка: проблема → решение → выгоды → детали → доверие
- Инфографика: усиливает ли желание купить, конкретные цифры/факты
- Конкурентоспособность: как это выглядит рядом с конкурентами в выдаче

══════════════════════════════════════
РОЛЬ 3: UX-СПЕЦИАЛИСТ МОБИЛЬНОГО ИНТЕРФЕЙСА
══════════════════════════════════════
Оцениваешь:
- Мобильная читаемость: текст на фото читаем при ширине 320px?
- Размер шрифтов: достаточно ли крупные для мобильного
- Информационная перегрузка: не слишком ли много текста/элементов на одном фото
- Контраст текста и фона: легко ли считывать

══════════════════════════════════════
РОЛЬ 4: ЦЕЛЕВОЙ ПОКУПАТЕЛЬ
══════════════════════════════════════
Оцениваешь:
- Привлекательность: хочу ли я это после просмотра фото?
- Понятность: я понял, что это и как это использовать?
- Доверие: фото вызывают доверие к качеству или сомнения?
- Размер/масштаб: я понимаю реальный размер товара?
- Вопросы: какие вопросы остались после просмотра всех фото?

══════════════════════════════════════
СКОРИНГ ФОТОГРАФИЙ
══════════════════════════════════════

photoScore = взвешенное среднее:
- firstImageEffectiveness (сила первого фото): вес 30%
- galleryLogic (логика галереи): вес 20%
- infographicQuality (качество инфографики): вес 20%
- mobileReadability (читаемость с мобильного): вес 15%
- overallVisualQuality (общее качество визуала): вес 15%

══════════════════════════════════════
ОБЯЗАТЕЛЬНЫЕ ТИПЫ ФОТО ПО КАТЕГОРИЯМ
══════════════════════════════════════

Для каждой категории существует набор ТИПОВ фото, которые должны
присутствовать в галерее. Порядок ты определяешь сам на основе
анализа конкретной карточки, её УТП и главной выгоды.

Одежда (8-10 фото). Обязательные типы:
на модели (полный рост), инфографика с выгодами, крупный план
ткани/фактуры, вид сзади/сбоку, размерная сетка, lifestyle
(реальный сценарий носки), комплектация/упаковка,
сравнение цветов (если есть варианты).

Обувь (8-10 фото). Обязательные типы:
пара (3/4 ракурс), на ноге (lifestyle), подошва крупно
(протектор, материал), инфографика с ТТХ, размерная сетка +
полнота, детали (швы, молния, шнуровка), профиль/стелька,
упаковка.

Электроника (7-10 фото). Обязательные типы:
товар на чистом фоне, инфографика с характеристиками,
в использовании (реальный сценарий), комплектация (всё из коробки),
размеры (рядом с предметом для масштаба), интерфейс/экран
(если применимо), разъёмы/подключения.

Косметика (7-10 фото). Обязательные типы:
упаковка на чистом фоне, инфографика (ключевой эффект + для кого),
текстура/свотч крупным планом, состав (ключевые ингредиенты
визуально), способ применения (пошагово), результат использования,
сертификаты/безопасность.

Товары для дома (7-10 фото). Обязательные типы:
товар целиком, инфографика с размерами и материалами,
в интерьере (реальный сценарий использования), детали/крупный план
качества, масштаб (рядом с человеком или предметом),
комплектация, уход/хранение.

Детские товары (8-10 фото). Обязательные типы:
товар целиком, инфографика с безопасностью и возрастом,
ребёнок с товаром (lifestyle), детали/качество швов/материалов,
размеры/масштаб, сертификаты безопасности, комплектация.

Если категория не из списка — проверяй наличие базового набора:
главное фото, инфографика с выгодами, в использовании, детали
качества, размер/масштаб, комплектация.

══════════════════════════════════════
ПРИНЦИПЫ ОЦЕНКИ ПОРЯДКА ГАЛЕРЕИ
══════════════════════════════════════

НЕ навязывай шаблонный порядок. Оценивай и рекомендуй порядок
на основе конкретного товара:

1. ПЕРВОЕ ФОТО = главный оффер. Тип первого фото зависит от УТП
   конкретного товара:
   - Если главное — дизайн/внешний вид → lifestyle или на модели
   - Если главное — технология/функция → инфографика с ключевой выгодой
   - Если главное — результат → до/после или результат использования
   - Если главное — качество материала → крупный план + текст

2. ГАЛЕРЕЯ = ВОРОНКА, но структура воронки зависит от товара:
   привлечь внимание → показать главную выгоду → закрыть сомнения →
   дать детали → подтолкнуть к покупке.

3. КАЖДОЕ СЛЕДУЮЩЕЕ ФОТО должно отвечать на следующий вопрос
   покупателя, а не повторять предыдущее.

4. ПОРЯДОК привязан к приоритету вопросов целевого покупателя
   этой конкретной категории и этого конкретного товара.

ЗАДАЧА АГЕНТА ПО ГАЛЕРЕЕ:
- Определи, какие типы фото ЕСТЬ в текущей карточке.
- Определи, каких типов НЕ ХВАТАЕТ для категории.
- Оцени текущий порядок: работает ли он как воронка для ЭТОГО товара.
- Предложи оптимальный порядок с обоснованием, привязанным к УТП
  и главной выгоде конкретного товара.
- Объясни, ПОЧЕМУ именно такой порядок — а не просто дай список.

══════════════════════════════════════
ПРАВИЛА
══════════════════════════════════════

1. Пиши ТОЛЬКО на русском. ЗАПРЕЩЕНО использовать английские слова вроде lifestyle, hero, main, infographic, detail, comparison и т.д. — используй ТОЛЬКО русские эквиваленты.
2. Верни СТРОГО валидный JSON.
3. НЕ ВЫДУМЫВАЙ то, чего не видно на фото. Если изображение нечёткое или данных мало — укажи это.
4. Для КАЖДОГО фото: опиши что видишь, оцени, дай конкретную рекомендацию.
5. Рекомендации = подробные конкретные брифы для дизайнера/фотографа. Каждый бриф должен включать: композицию, фон, ракурс, текст на фото, цветовую гамму, что убрать, что добавить.
6. Оценивай с точки зрения CTR (клик в выдаче) и CVR (конверсия в корзину).
7. НЕ давай шаблонный порядок фото. Обосновывай порядок через УТП и выгоды конкретного товара.`;

const STAGE3_SYSTEM_PROMPT = `Ты — senior-стратег по оптимизации карточек Wildberries.
${WB_FIELD_LIMITS}
Твоя задача — объединить два независимых аудита (карточки и фотографий) в один финальный, прикладной результат.

══════════════════════════════════════
ЧТО ТЫ ДЕЛАЕШЬ
══════════════════════════════════════

1. Объединяешь выводы обоих аудитов
2. Убираешь повторы и противоречия
3. Выделяешь КОРНЕВЫЕ причины слабости карточки (не симптомы)
4. Формируешь чек-лист, отсортированный по приоритету
5. Распределяешь задачи по ролям (дизайнер, контентщик, SEO, маркетолог)
6. Даёшь A/B гипотезы для тестирования

══════════════════════════════════════
ФОРМУЛА ФИНАЛЬНОГО SCORE
══════════════════════════════════════

overallScore = (cardScore × 0.45) + (photoScore × 0.55)

Фото весят больше, потому что на WB визуал = главный фактор CTR и первого впечатления.

══════════════════════════════════════
ПРАВИЛА
══════════════════════════════════════

1. Пиши ТОЛЬКО на русском. ЗАПРЕЩЕНО использовать английские слова — все тексты, описания, рекомендации на русском.
2. НЕ ПРИДУМЫВАЙ новые факты. Используй ТОЛЬКО данные из входных аудитов.
3. Если вывод противоречит входным данным — не включай его.
4. Все действия в чек-листе = конкретные, внедряемые за указанное время.
5. Чек-лист отсортирован: critical → high → medium → low.
6. Каждое действие привязано к роли (кто делает).
7. Добавь блок expectedImpactSummary — что произойдёт, если выполнить весь чек-лист.
8. Верни ТОЛЬКО валидный JSON.`;

// ── Helper: build user prompts ───────────────────────────────────

function buildStage1UserPrompt(context: CardSnapshot['context'], card: Omit<CardSnapshot, 'context'>): string {
  return `Проведи глубокий аудит карточки товара Wildberries.

Оцени с позиций: маркетолог, психолог, целевой покупатель, контент-стратег, SEO-специалист.

Верни JSON строго по этой схеме:

{
  "overallScore": 0,
  "confidence": 0,
  "summary": "2-3 предложения: главный вывод",
  "assumptions": [],
  "missingData": [],

  "scores": {
    "offerClarity": 0,
    "titleSeo": 0,
    "descriptionPersuasion": 0,
    "trustSignals": 0,
    "benefitCommunication": 0,
    "conversionReadiness": 0
  },

  "perspectives": {
    "marketer": {
      "offerAssessment": "Насколько понятен и силён оффер",
      "positioningAssessment": "Как карточка выглядит vs конкуренты/категория",
      "pricingAssessment": "Оценка ценообразования (если есть данные о цене)",
      "strengths": [],
      "issues": [],
      "recommendations": []
    },
    "psychologist": {
      "emotionalTriggers": "Какие эмоции вызывает / не вызывает",
      "trustLevel": "Уровень доверия и почему",
      "aidaAnalysis": "На каком этапе AIDA теряется покупатель",
      "mainMotivations": [],
      "mainFears": [],
      "unclosedObjections": [],
      "strengths": [],
      "issues": [],
      "recommendations": []
    },
    "buyer": {
      "firstImpression": "Что я вижу за 3 секунды",
      "unansweredQuestions": [],
      "purchaseBlockers": [],
      "decisionTrigger": "Что заставило бы купить / чего не хватает",
      "wouldIBuy": "Да/Нет/Может быть — и почему",
      "strengths": [],
      "issues": [],
      "recommendations": []
    }
  },

  "contentAnalysis": {
    "title": {
      "currentLength": 0,
      "score": 0,
      "problems": [],
      "suggestedTitle": "Готовый новый заголовок для копипаста",
      "reasoning": "Почему этот вариант лучше"
    },
    "description": {
      "currentLength": 0,
      "score": 0,
      "problems": [],
      "missingBlocks": [],
      "suggestedRewrite": "Готовый новый текст описания (или первые 500 символов + структура остальных)",
      "reasoning": "Почему эта структура лучше"
    },
    "characteristics": {
      "filledCount": 0,
      "score": 0,
      "problems": [],
      "missingCharacteristics": [
        {"name": "Название", "suggestedValue": "Значение", "why": "Зачем это нужно"}
      ]
    }
  },

  "seo": {
    "titleKeywords": {
      "found": [],
      "missing": [],
      "spam": []
    },
    "descriptionKeywords": {
      "found": [],
      "missing": []
    },
    "recommendedKeywords": [],
    "issues": []
  },

  "quickFixes": [
    {
      "action": "Конкретное действие",
      "timeMinutes": 5,
      "expectedImpact": "Что изменится"
    }
  ],

  "priorityActions": [
    {
      "priority": "critical|high|medium|low",
      "action": "Конкретное действие",
      "expectedImpact": "high|medium|low",
      "reason": "Почему это важно",
      "assignee": "contentManager|seoSpecialist|marketer"
    }
  ]
}

Контекст:
${JSON.stringify(context, null, 2)}

Карточка:
${JSON.stringify(card, null, 2)}`;
}

function buildStage2UserPromptVision(cardContext: object): string {
  return `Проведи глубокий визуальный аудит фотографий карточки товара Wildberries.

Фотографии приложены к сообщению в порядке их расположения в карточке.
Фото 1 = главное фото (обложка).

Оцени:
1. Первое фото — цепляет ли, понятен ли товар, конкурентоспособно ли в выдаче
2. Каждое фото отдельно — что на нём, что хорошо, что плохо
3. Галерею как сценарий — есть ли логика, ведёт ли к покупке
4. Инфографику — читаема ли с мобильного, убедительна ли
5. Чего не хватает для максимального CTR и конверсии

Верни JSON строго по схеме:

{
  "photoScore": 0,
  "confidence": 0,
  "summary": "2-3 предложения: главный вывод по фото",
  "assumptions": [],
  "missingData": [],

  "scores": {
    "firstImageEffectiveness": 0,
    "galleryLogic": 0,
    "infographicQuality": 0,
    "mobileReadability": 0,
    "overallVisualQuality": 0
  },

  "firstImage": {
    "score": 0,
    "description": "Что я вижу на первом фото",
    "attentionGrab": "Останавливает ли скролл и почему",
    "offerClarity": "Считывается ли товар и его ценность за 2 секунды",
    "strengths": [],
    "issues": [],
    "conversionBarriers": [],
    "recommendations": [],
    "designerBrief": "Подробное ТЗ для дизайнера: 1) Композиция и ракурс. 2) Фон (цвет, сцена). 3) Текст на фото (заголовок, УТП, размер шрифта). 4) Иконки/графика. 5) Что убрать. 6) Референс стиля."
  },

  "detailedPhotos": [
    {
      "photoIndex": 1,
      "description": "Что я вижу",
      "type": "главное фото|инфографика|образ жизни|детали|размеры|использование|упаковка|сравнение|другое",
      "score": 0,
      "strengths": [],
      "issues": [],
      "psychologicalImpact": "Какое впечатление создаёт",
      "mobileReadability": "Читаемо ли с мобильного",
      "recommendations": [],
      "designerBrief": "Подробное ТЗ на переработку этого фото: что изменить, как снять, какие элементы добавить/убрать, какой фон, какой ракурс"
    }
  ],

  "gallery": {
    "score": 0,
    "currentSequenceLogic": "Описание текущей логики: в каком порядке подаётся информация",
    "logicProblems": [],
    "recommendedSequence": [
      {
        "position": 1,
        "type": "главное фото|инфографика|образ жизни|детали|размеры|использование|упаковка|сравнение",
        "content": "Что должно быть на этом фото",
        "why": "Почему именно здесь — привязка к УТП и вопросам покупателя"
      }
    ],
    "missingFrames": [
      {
        "type": "образ жизни|размеры|детали|сравнение|инфографика|...",
        "description": "Чего не хватает",
        "why": "Зачем это нужно для конверсии",
        "designerBrief": "Подробное ТЗ на создание: сценарий съёмки, фон, ракурс, что показать крупно, какие текстовые элементы добавить, размер шрифтов, цветовая гамма"
      }
    ]
  },

  "infographics": {
    "score": 0,
    "strengths": [],
    "issues": [],
    "textReadabilityMobile": "Оценка читаемости текста на мобильном",
    "dataToShow": ["Какие данные/факты стоит вынести на инфографику"],
    "recommendations": []
  },

  "videoRecommendation": {
    "needed": true,
    "priority": "высокий|средний|низкий",
    "content": "О чём должно быть видео — сценарий по кадрам",
    "duration": "Рекомендуемая длительность",
    "brief": "Подробное ТЗ для видеографа: формат, сценарий посекундно, музыка, текст на экране, стиль съёмки"
  },

  "quickFixes": [
    {
      "action": "Конкретное действие",
      "timeMinutes": 0,
      "expectedImpact": "Что изменится"
    }
  ],

  "priorityActions": [
    {
      "priority": "critical|high|medium|low",
      "action": "Конкретное действие",
      "expectedImpact": "high|medium|low",
      "reason": "Почему это важно",
      "assignee": "designer|photographer|contentManager"
    }
  ]
}

Контекст карточки (для понимания товара):
${JSON.stringify(cardContext, null, 2)}`;
}

function buildStage2UserPromptFallback(photosCount: number, hasVideo: boolean, subjectName: string | null, cardContext: object): string {
  return `Фотографий нет. Доступна только метаинформация:
- Количество фото: ${photosCount}
- Есть видео: ${hasVideo}
- Категория: ${subjectName ?? 'Неизвестная'}

Дай рекомендации на основе:
1. Количества фото (достаточно ли для категории)
2. Типичных требований к фото в категории ${subjectName ?? 'Неизвестная'}
3. Лучших практик топовых карточек WB

Поставь confidence не выше 40, так как фото не анализировались.

Верни JSON строго по схеме:

{
  "photoScore": 0,
  "confidence": 0,
  "summary": "2-3 предложения: главный вывод по фото",
  "assumptions": [],
  "missingData": [],

  "scores": {
    "firstImageEffectiveness": 0,
    "galleryLogic": 0,
    "infographicQuality": 0,
    "mobileReadability": 0,
    "overallVisualQuality": 0
  },

  "firstImage": {
    "score": 0,
    "description": "Что я вижу на первом фото",
    "attentionGrab": "Останавливает ли скролл и почему",
    "offerClarity": "Считывается ли товар и его ценность за 2 секунды",
    "strengths": [],
    "issues": [],
    "conversionBarriers": [],
    "recommendations": [],
    "designerBrief": "Подробное ТЗ для дизайнера: 1) Композиция и ракурс. 2) Фон (цвет, сцена). 3) Текст на фото (заголовок, УТП, размер шрифта). 4) Иконки/графика. 5) Что убрать. 6) Референс стиля."
  },

  "detailedPhotos": [],

  "gallery": {
    "score": 0,
    "currentSequenceLogic": "Не анализировалось — фото не предоставлены",
    "logicProblems": [],
    "recommendedSequence": [
      {
        "position": 1,
        "type": "main",
        "content": "Что должно быть на этом фото",
        "why": "Почему именно здесь — привязка к УТП и вопросам покупателя"
      }
    ],
    "missingFrames": [
      {
        "type": "lifestyle|size|detail|comparison|...",
        "description": "Чего не хватает",
        "why": "Зачем это нужно для конверсии",
        "designerBrief": "ТЗ на создание"
      }
    ]
  },

  "infographics": {
    "score": 0,
    "strengths": [],
    "issues": [],
    "textReadabilityMobile": "Не анализировалось",
    "dataToShow": [],
    "recommendations": []
  },

  "videoRecommendation": {
    "needed": true,
    "priority": "высокий|средний|низкий",
    "content": "О чём должно быть видео — сценарий по кадрам",
    "duration": "Рекомендуемая длительность",
    "brief": "Подробное ТЗ для видеографа: формат, сценарий посекундно, музыка, текст на экране, стиль съёмки"
  },

  "quickFixes": [],

  "priorityActions": []
}

Контекст карточки (для понимания товара):
${JSON.stringify(cardContext, null, 2)}`;
}

/**
 * Extract only the fields Stage 3 actually needs from a full audit JSON.
 * The full Stage 1/2 payloads are ~6k tokens each — most of that is
 * narrative text that Stage 3 never references (perspectives.marketer.
 * aidaAnalysis, buyer.firstImpression, etc.). Keeping just scores + top
 * issues/recommendations cuts Stage 3 input from ~15k → ~5k tokens and
 * removes the temptation for the model to re-paraphrase them.
 */
function summariseForSynthesis(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, any>;
  const pickTop = (arr: any, n = 5) =>
    Array.isArray(arr) ? arr.slice(0, n) : undefined;

  return {
    overallScore: r.overallScore,
    confidence: r.confidence,
    summary: r.summary,
    scores: r.scores,
    // Top issues & recommendations only — Stage 3 prioritises, doesn't
    // re-describe.
    topIssues: pickTop(r.topIssues ?? r.issues ?? r.criticalIssues),
    topRecommendations: pickTop(r.topRecommendations ?? r.recommendations),
    perspectives: r.perspectives
      ? Object.fromEntries(
          Object.entries(r.perspectives).map(([k, v]: [string, any]) => [
            k,
            { issues: pickTop(v?.issues, 3), recommendations: pickTop(v?.recommendations, 3) },
          ]),
        )
      : undefined,
    // Already-generated rewrites — Stage 3 reuses verbatim rather than
    // regenerating.
    contentAnalysis: r.contentAnalysis
      ? {
          title: r.contentAnalysis.title
            ? { score: r.contentAnalysis.title.score, suggestedTitle: r.contentAnalysis.title.suggestedTitle }
            : undefined,
          description: r.contentAnalysis.description
            ? { score: r.contentAnalysis.description.score, suggestedRewrite: r.contentAnalysis.description.suggestedRewrite }
            : undefined,
          characteristics: r.contentAnalysis.characteristics
            ? { score: r.contentAnalysis.characteristics.score, missingCharacteristics: pickTop(r.contentAnalysis.characteristics.missingCharacteristics, 10) }
            : undefined,
        }
      : undefined,
    seo: r.seo,
    photos: pickTop(r.photos, 7),
    galleryScore: r.galleryScore,
    firstImageScore: r.firstImageScore,
  };
}

function buildStage3UserPrompt(cardAuditJson: unknown, photoAuditJson: unknown): string {
  return `Объедини два аудита карточки Wildberries в финальный action plan.

Верни JSON строго по схеме:

{
  "meta": {
    "nmId": 0,
    "subjectName": "",
    "auditVersion": "v3.0",
    "language": "ru",
    "timestamp": ""
  },

  "overallScore": 0,
  "cardScore": 0,
  "photoScore": 0,
  "confidence": 0,

  "verdict": {
    "summary": "Главный вывод 2-3 предложения",
    "positioning": "Как считывается оффер",
    "conversionRisk": "critical|high|medium|low",
    "mainProblem": "Одна ключевая корневая проблема карточки"
  },

  "scores": {
    "offerClarity": 0,
    "titleSeo": 0,
    "descriptionPersuasion": 0,
    "trustSignals": 0,
    "benefitCommunication": 0,
    "conversionReadiness": 0,
    "firstImageEffectiveness": 0,
    "galleryLogic": 0,
    "infographicQuality": 0,
    "mobileReadability": 0,
    "overallVisualQuality": 0
  },

  "rootCauses": [
    "Корневая причина 1 (не симптом, а причина)",
    "Корневая причина 2"
  ],

  "topStrengths": [
    "Что НЕ нужно менять — это работает"
  ],

  "topIssues": [
    {
      "issue": "Проблема",
      "impact": "critical|high|medium|low",
      "rootCause": "Почему это проблема",
      "fix": "Конкретное решение"
    }
  ],

  "contentRewrites": {
    "suggestedTitle": "Готовый новый заголовок",
    "suggestedDescription": "Готовый новый текст описания (или первые 500 символов + структура)",
    "characteristicsToAdd": [
      {"name": "...", "value": "...", "why": "..."}
    ]
  },

  "checklist": {
    "doNow": [
      {
        "step": 1,
        "action": "Конкретное действие",
        "assignee": "designer|contentManager|seoSpecialist|marketer|photographer",
        "timeMinutes": 0,
        "expectedResult": "Что улучшится"
      }
    ],
    "doNext": [
      {
        "step": 1,
        "action": "...",
        "assignee": "...",
        "timeMinutes": 0,
        "expectedResult": "..."
      }
    ],
    "testHypotheses": [
      {
        "hypothesis": "Что тестировать",
        "variant_a": "Вариант А",
        "variant_b": "Вариант Б",
        "metric": "По какой метрике оценивать",
        "expectedLift": "Ожидаемый рост"
      }
    ]
  },

  "roleTasks": {
    "designer": [
      {
        "task": "Конкретная задача",
        "brief": "ТЗ для дизайнера",
        "priority": "critical|high|medium|low",
        "timeEstimate": "1 час / 2 часа / 1 день"
      }
    ],
    "contentManager": [
      {
        "task": "...",
        "brief": "...",
        "priority": "...",
        "timeEstimate": "..."
      }
    ],
    "seoSpecialist": [],
    "photographer": [],
    "marketer": []
  },

  "expectedImpactSummary": "Что изменится, если выполнить весь чек-лист (прогноз по CTR, конверсии, возвратам)",
  "finalVerdict": "Итоговый вердикт: 1-2 предложения с главным посылом"
}

Аудит карточки (только ключевые поля — НЕ повторяй их дословно, синтезируй):
${JSON.stringify(summariseForSynthesis(cardAuditJson), null, 2).slice(0, 4000)}

Аудит фотографий (только ключевые поля):
${JSON.stringify(summariseForSynthesis(photoAuditJson), null, 2).slice(0, 4000)}`;
}

// ── Cost helpers ─────────────────────────────────────────────────

// Модель для аудита карточек — Opus 4.8 (вышел 2026-05-28). Vision 2576px
// (vs Sonnet 1568px) важен для распознавания мелкого текста на карточках и
// инфографике. Стоит $5/$25 за 1M (vs Sonnet $3/$15), но аудит карточки —
// разовая операция, увеличение бюджета приемлемо ради качества.
//
// ВАЖНО: Opus 4.7+ не принимает `temperature`, `top_p`, `top_k`, `budget_tokens`.
// Все эти параметры удалены из вызовов ниже.
const AUDIT_MODEL = 'claude-sonnet-4-6';

const SONNET_INPUT_PRICE = 3; // $/1M tokens
const SONNET_OUTPUT_PRICE = 15; // $/1M tokens

function computeCostUsd(promptTokens: number, completionTokens: number): string {
  const cost = (promptTokens / 1_000_000) * SONNET_INPUT_PRICE + (completionTokens / 1_000_000) * SONNET_OUTPUT_PRICE;
  return cost.toFixed(6);
}

// ── 1. collectCardData ───────────────────────────────────────────

export async function collectCardData(workspaceId: number, nmId: number): Promise<CardSnapshot> {
  const [card] = await db
    .select()
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);

  if (!card) {
    throw new Error(`Card not found: workspaceId=${workspaceId}, nmId=${nmId}`);
  }

  const raw = (card.raw ?? {}) as Record<string, unknown>;
  const description = (raw.description as string) ?? null;
  const characteristics = (raw.characteristics as Array<{ name: string; value: string }>) ?? [];

  const photos = (card.photos ?? []) as Array<string | { big?: string; small?: string }>;
  const photoUrls: string[] = photos.map((p) => {
    if (typeof p === 'string') return p;
    return p.big ?? p.small ?? '';
  }).filter(Boolean);

  return {
    nmId,
    vendorCode: card.vendorCode,
    title: card.title,
    brandName: card.brandName,
    subjectName: card.subjectName,
    description,
    characteristics,
    photosCount: photoUrls.length,
    photoUrls,
    context: {
      marketplace: 'wildberries',
      goal: 'increase_ctr_and_conversion',
      targetAudience: null,
      sellerType: 'unknown',
      category: card.subjectName,
      competitorContext: null,
    },
  };
}

// ── 2. saveSnapshot ──────────────────────────────────────────────

export async function saveSnapshot(
  workspaceId: number,
  nmId: number,
  data: CardSnapshot,
  photoUrls: string[]
): Promise<number> {
  const [row] = await db
    .insert(creativeCardSnapshots)
    .values({
      workspaceId,
      nmId,
      snapshotData: data,
      photoUrls,
    })
    .returning({ snapshotId: creativeCardSnapshots.snapshotId });

  return row.snapshotId;
}

// ── 3. Stage 1 — Card Audit ─────────────────────────────────────

export async function runStage1_CardAudit(
  snapshot: CardSnapshot,
  workspaceId: number,
  nmId: number,
  snapshotId: number
): Promise<StageResult<unknown>> {
  const systemPrompt = STAGE1_SYSTEM_PROMPT
    .replace(/\{\{subjectName\}\}/g, snapshot.subjectName ?? 'Неизвестная категория');

  const { context, ...cardData } = snapshot;
  const userPrompt = buildStage1UserPrompt(context, cardData);

  const result = await claudeChatJson<unknown>(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.3,
      model: AUDIT_MODEL,
      maxTokens: 32768,
      meta: {
        workspaceId,
        feature: 'creative-audit-v3-card',
        itemType: 'wb_card',
        itemId: String(nmId),
        charge: true,
      },
    }
  );

  const usage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const costUsd = computeCostUsd(usage.promptTokens, usage.completionTokens);

  const [row] = await db
    .insert(creativeCardAuditRuns)
    .values({
      snapshotId,
      workspaceId,
      nmId,
      modelName: result.model,
      promptVersion: 'v3.0',
      auditJson: result.data as Record<string, unknown>,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      costUsd,
    })
    .returning({ id: creativeCardAuditRuns.id });

  return { auditJson: result.data, id: row.id, usage };
}

// ── 4. Stage 2 — Photo Audit ────────────────────────────────────

export async function runStage2_PhotoAudit(
  snapshot: CardSnapshot,
  workspaceId: number,
  nmId: number,
  snapshotId: number
): Promise<StageResult<unknown>> {
  const systemPrompt = STAGE2_SYSTEM_PROMPT;

  const cardContext = {
    nmId: snapshot.nmId,
    title: snapshot.title,
    brandName: snapshot.brandName,
    subjectName: snapshot.subjectName,
    description: snapshot.description,
    photosCount: snapshot.photosCount,
  };

  const hasPhotos = snapshot.photoUrls.length > 0;

  let result;
  let visionMode = false;
  let photosAnalyzed = 0;

  if (hasPhotos) {
    // Mode A: Try Vision API with actual images, fallback to Mode B on error
    visionMode = true;
    photosAnalyzed = snapshot.photoUrls.length;

    try {
      const userPromptText = buildStage2UserPromptVision(cardContext);

      // Cap at 5 photos per audit — each image costs ~1 600 input tokens on
      // vision, and measured outputs rarely reference photos #6+ meaningfully.
      // Keeps runtime and spend bounded on long-tail cards with 20+ shots.
      const photoUrlsForVision = snapshot.photoUrls.slice(0, 5);

      const photoBlocks: ContentBlock[] = photoUrlsForVision.map((url) => ({
        type: 'image' as const,
        source: { type: 'url' as const, url },
      }));

      photosAnalyzed = photoUrlsForVision.length;

      const userContent: ContentBlock[] = [
        { type: 'text' as const, text: userPromptText },
        ...photoBlocks,
      ];

      result = await claudeVisionJson<unknown>(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        {
          temperature: 0.3,
          model: AUDIT_MODEL,
          // Kept at 32 768 per product decision — the audit JSON is rich
          // (per-photo findings + stage-2 rewrite drafts) and truncation
          // corrupts downstream stages.
          maxTokens: 32768,
          meta: {
            workspaceId,
            feature: 'creative-audit-v3-photo',
            itemType: 'wb_card',
            itemId: String(nmId),
            charge: true,
          },
        }
      );
    } catch (visionErr) {
      // Fallback to Mode B (text-only) if Vision fails
      console.warn('Vision API failed, falling back to Mode B:', (visionErr as Error).message);
      visionMode = false;
      hasPhotos && (photosAnalyzed = 0);
      // Fall through to Mode B below
    }
  }

  if (!result) {
    // Mode B: Fallback text-only, confidence <= 40
    visionMode = false;
    photosAnalyzed = 0;

    const userPrompt = buildStage2UserPromptFallback(
      snapshot.photosCount,
      false,
      snapshot.subjectName,
      cardContext
    );

    result = await claudeChatJson<unknown>(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: 0.3,
        model: AUDIT_MODEL,
        maxTokens: 32768,
        meta: {
          workspaceId,
          feature: 'creative-audit-v3-photo-fallback',
          charge: true,
          itemType: 'wb_card',
          itemId: String(nmId),
        },
      }
    );
  }

  const usage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const costUsd = computeCostUsd(usage.promptTokens, usage.completionTokens);

  const [row] = await db
    .insert(creativePhotoAuditRuns)
    .values({
      snapshotId,
      workspaceId,
      nmId,
      modelName: result.model,
      promptVersion: 'v3.0',
      photosAnalyzed,
      visionMode,
      auditJson: result.data as Record<string, unknown>,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      costUsd,
    })
    .returning({ id: creativePhotoAuditRuns.id });

  return { auditJson: result.data, id: row.id, usage };
}

// ── 5. Stage 3 — Synthesis ──────────────────────────────────────

export async function runStage3_Synthesis(
  cardAudit: StageResult<unknown>,
  photoAudit: StageResult<unknown>,
  workspaceId: number,
  nmId: number,
  snapshotId: number,
  cardAuditId: number,
  photoAuditId: number,
  shopId?: number | null,
): Promise<{ finalAudit: unknown; id: number; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const userPrompt = buildStage3UserPrompt(cardAudit.auditJson, photoAudit.auditJson);

  const result = await claudeChatJson<Record<string, unknown>>(
    [
      { role: 'system', content: STAGE3_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.2,
      model: AUDIT_MODEL,
      // Full budget — полный синтезированный аудит без усечения (user decision).
      maxTokens: 32768,
      meta: {
        workspaceId,
        feature: 'creative-audit-v3-synthesis',
        charge: true,
        itemType: 'wb_card',
        itemId: String(nmId),
      },
    }
  );

  const usage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const costUsd = computeCostUsd(usage.promptTokens, usage.completionTokens);

  const finalData = result.data;
  const llmOverall = typeof finalData.overallScore === 'number' ? finalData.overallScore : null;
  const llmCard = typeof finalData.cardScore === 'number' ? finalData.cardScore : null;
  const llmPhoto = typeof finalData.photoScore === 'number' ? finalData.photoScore : null;

  // Synthesizer occasionally returns overallScore=0 even when sub-scores
  // (45-82) make a 0 impossible. Recompute deterministically using the
  // documented formula whenever the LLM total is missing, ≤0 or clearly
  // inconsistent with the stage scores. Same defensive backfill for
  // cardScore/photoScore from the scores block.
  const scoresBlock = (finalData as any).scores ?? {};
  const cardScoreKeys = ['offerClarity', 'titleSeo', 'descriptionPersuasion', 'trustSignals', 'benefitCommunication', 'conversionReadiness'];
  const photoScoreKeys = ['firstImageEffectiveness', 'galleryLogic', 'infographicQuality', 'mobileReadability', 'overallVisualQuality'];
  const avg = (keys: string[]) => {
    const vals = keys.map((k) => scoresBlock[k]).filter((v) => typeof v === 'number' && v > 0);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  let cardScore = llmCard;
  if (cardScore == null || cardScore <= 0) cardScore = avg(cardScoreKeys);
  let photoScore = llmPhoto;
  if (photoScore == null || photoScore <= 0) photoScore = avg(photoScoreKeys);

  let overallScore: number | null = llmOverall;
  const overallLooksWrong = overallScore == null
    || overallScore <= 0
    || (cardScore != null && photoScore != null && overallScore < Math.min(cardScore, photoScore) / 2);
  if (overallLooksWrong && cardScore != null && photoScore != null) {
    overallScore = Math.round(cardScore * 0.45 + photoScore * 0.55);
  } else if (overallLooksWrong && (cardScore != null || photoScore != null)) {
    overallScore = cardScore ?? photoScore;
  }

  // Persist backfilled scores into the JSON so the UI/PDF don't have to
  // duplicate this fallback logic. Always store what the row stored.
  if (overallScore != null) (finalData as any).overallScore = overallScore;
  if (cardScore != null) (finalData as any).cardScore = cardScore;
  if (photoScore != null) (finalData as any).photoScore = photoScore;

  const confidence = typeof finalData.confidence === 'number' ? finalData.confidence : null;

  const [row] = await db
    .insert(creativeAuditRunsFinal)
    .values({
      cardAuditId,
      photoAuditId,
      snapshotId,
      workspaceId,
      shopId: shopId ?? null,
      nmId,
      modelName: result.model,
      promptVersion: 'v3.0',
      isValidated: false,
      finalJson: finalData,
      overallScore,
      cardScore,
      photoScore,
      confidence,
      isFree: true,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      totalCostUsd: costUsd,
    })
    .returning({ id: creativeAuditRunsFinal.id });

  return { finalAudit: finalData, id: row.id, usage };
}

// ── Helpers: extract photos/seo from Stage 1/2 for frontend ─────

function extractPhotosFromStage2(photoJson: any, photoUrls: string[] = []) {
  if (!photoJson) return null;
  // Zip the original photo URLs into detailedPhotos[i] so the UI can render
  // each shot next to its score. Stage 2 receives photos by index, so the
  // i-th detailedPhotos entry corresponds to the i-th photoUrl.
  const detailedPhotos = (photoJson.detailedPhotos ?? []).map((photo: any, i: number) => ({
    ...photo,
    imageUrl: photo?.imageUrl ?? photoUrls[i] ?? null,
  }));
  const firstImage = photoJson.firstImage
    ? { ...photoJson.firstImage, imageUrl: photoJson.firstImage.imageUrl ?? photoUrls[0] ?? null }
    : null;
  return {
    firstImage,
    detailedPhotos,
    gallery: photoJson.gallery ?? {},
    missingFrames: photoJson.gallery?.missingFrames ?? [],
    videoRecommendation: photoJson.videoRecommendation ?? null,
    infographics: photoJson.infographics ?? null,
    scores: photoJson.scores ?? null,
  };
}

function extractSeoFromStage1(cardJson: any) {
  if (!cardJson?.seo) return null;
  return {
    titleKeywords: cardJson.seo.titleKeywords ?? {},
    descriptionKeywords: cardJson.seo.descriptionKeywords ?? {},
    recommendedKeywords: cardJson.seo.recommendedKeywords ?? [],
    issues: cardJson.seo.issues ?? [],
  };
}

export { extractPhotosFromStage2, extractSeoFromStage1 };

// ── Quick Audit (Bulk Mode) ─────────────────────────────────────

const QUICK_AUDIT_SYSTEM_PROMPT = `Ты — эксперт по аудиту карточек Wildberries. Быстрый скоринг.
${WB_FIELD_LIMITS}
ФОРМАТ ОТВЕТА: Только JSON, без markdown, без \`\`\`json\`\`\`. Начни с { и заканчивай }.

score (0-100): titleQuality(15%) + descriptionQuality(20%) + characteristicsCompleteness(15%) + offerClarity(20%) + seoOptimization(15%) + conversionReadiness(15%)

estimatedImprovementPotential: high (>20% роста) | medium (10-20%) | low (<10%)

КРАТКОСТЬ ОБЯЗАТЕЛЬНА. Максимум 50 слов на summary/topIssue/topStrength.`;

const QUICK_AUDIT_USER_PROMPT = `{"score":0,"estimatedImprovementPotential":"high|medium|low","confidence":0,"summary":"кратко","topIssue":"кратко","topStrength":"кратко","scores":{"titleQuality":0,"descriptionQuality":0,"characteristicsCompleteness":0,"offerClarity":0,"seoOptimization":0,"conversionReadiness":0}}

Карточка:
`;

export interface QuickAuditResult {
  nmId: number;
  score: number;
  estimatedImprovementPotential: 'high' | 'medium' | 'low';
  confidence: number;
  summary: string;
  topIssue: string | null;
  topStrength: string | null;
  scores: {
    titleQuality: number;
    descriptionQuality: number;
    characteristicsCompleteness: number;
    offerClarity: number;
    seoOptimization: number;
    conversionReadiness: number;
  };
  tokenUsage: number;
  costUsd: string;
}

export async function runQuickAudit(
  workspaceId: number,
  nmId: number
): Promise<QuickAuditResult> {
  // 1. Get card data (minimal, no photos)
  const [card] = await db
    .select({
      nmId: wbCards.nmId,
      title: wbCards.title,
      brandName: wbCards.brandName,
      subjectName: wbCards.subjectName,
      raw: wbCards.raw,
    })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), eq(wbCards.nmId, nmId)))
    .limit(1);

  if (!card) {
    throw new Error(`Card not found: nmId=${nmId}`);
  }

  const raw = (card.raw ?? {}) as Record<string, unknown>;
  const description = (raw.description as string) ?? '';
  const characteristics = (raw.characteristics as Array<{ name: string; value: string }>) ?? [];

  const cardData = {
    nmId: card.nmId,
    title: card.title,
    brandName: card.brandName,
    subjectName: card.subjectName,
    description: description.slice(0, 1500), // Truncate for speed
    characteristicsCount: characteristics.length,
    characteristics: characteristics.slice(0, 15), // Limit to 15
  };

  // 2. Call LLM
  const result = await claudeChatJson<{
    score: number;
    estimatedImprovementPotential: 'high' | 'medium' | 'low';
    confidence: number;
    summary: string;
    topIssue?: string;
    topStrength?: string;
    scores: {
      titleQuality: number;
      descriptionQuality: number;
      characteristicsCompleteness: number;
      offerClarity: number;
      seoOptimization: number;
      conversionReadiness: number;
    };
  }>(
    [
      { role: 'system', content: QUICK_AUDIT_SYSTEM_PROMPT },
      { role: 'user', content: QUICK_AUDIT_USER_PROMPT + JSON.stringify(cardData, null, 2) },
    ],
    {
      temperature: 0.2,
      model: AUDIT_MODEL,
      maxTokens: 4096,
      meta: {
        workspaceId,
        feature: 'creative-audit-quick',
        charge: true,
        itemType: 'wb_card',
        itemId: String(nmId),
      },
    }
  );

  const usage = result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const costUsd = computeCostUsd(usage.promptTokens, usage.completionTokens);

  return {
    nmId,
    score: Math.max(0, Math.min(100, result.data.score ?? 0)),
    estimatedImprovementPotential: result.data.estimatedImprovementPotential ?? 'medium',
    confidence: result.data.confidence ?? 50,
    summary: result.data.summary ?? '',
    topIssue: result.data.topIssue ?? null,
    topStrength: result.data.topStrength ?? null,
    scores: result.data.scores ?? {
      titleQuality: 0,
      descriptionQuality: 0,
      characteristicsCompleteness: 0,
      offerClarity: 0,
      seoOptimization: 0,
      conversionReadiness: 0,
    },
    tokenUsage: usage.totalTokens,
    costUsd,
  };
}

export interface BulkAuditResult {
  results: QuickAuditResult[];
  totalTokens: number;
  totalCostUsd: string;
  processedCount: number;
  failedCount: number;
  failedNmIds: number[];
}

// ── 6. Full Audit Orchestrator ───────────────────────────────────

export async function runFullAuditV3(
  workspaceId: number,
  nmId: number,
  opts?: { isFree?: boolean; shopId?: number | null }
): Promise<{
  finalAudit: unknown;
  meta: AuditMeta;
}> {
  // 1. Collect card data
  const snapshot = await collectCardData(workspaceId, nmId);

  // 2. Save snapshot
  const snapshotId = await saveSnapshot(workspaceId, nmId, snapshot, snapshot.photoUrls);

  // 3. Run Stage 1 (text) and Stage 2 (vision) IN PARALLEL.
  //
  // Session-26 rework: previously sequential with the comment "parallel
  // causes socket issues on Windows", but that was back when both stages
  // shared a single spawn+https pipeline. Now that claudeChatJson and
  // claudeVisionJson both use the streaming SDK, concurrent requests no
  // longer interfere and audits are ~40% faster.
  //
  // `allSettled` so one stage failing does not kill the other — the user
  // still gets partial results (text-only or vision-only synthesis).
  console.log('[audit-v3] Starting Stage 1 + Stage 2 in parallel...');
  const t0 = Date.now();
  const [stage1Res, stage2Res] = await Promise.allSettled([
    runStage1_CardAudit(snapshot, workspaceId, nmId, snapshotId),
    runStage2_PhotoAudit(snapshot, workspaceId, nmId, snapshotId),
  ]);
  console.log(`[audit-v3] Stages 1+2 completed in ${Date.now() - t0}ms`);

  const cardAudit = stage1Res.status === 'fulfilled' ? stage1Res.value : null;
  const photoAudit = stage2Res.status === 'fulfilled' ? stage2Res.value : null;

  if (!cardAudit && !photoAudit) {
    const s1 = stage1Res.status === 'rejected' ? stage1Res.reason : null;
    const s2 = stage2Res.status === 'rejected' ? stage2Res.reason : null;
    throw new Error(`Both audit stages failed. Stage1: ${s1?.message ?? s1}. Stage2: ${s2?.message ?? s2}`);
  }
  if (!cardAudit) {
    console.warn('[audit-v3] Stage 1 failed, synthesizing from vision only:', (stage1Res as PromiseRejectedResult).reason?.message);
  }
  if (!photoAudit) {
    console.warn('[audit-v3] Stage 2 failed, synthesizing from text only:', (stage2Res as PromiseRejectedResult).reason?.message);
  }

  // 4. Run Stage 3 — Synthesis. Skip the 5s inter-stage pause (was there to
  //    give Anthropic rate limits time to recover between sequential calls —
  //    not needed when stages ran in parallel).
  console.log('[audit-v3] Starting Stage 3 (Synthesis)...');
  const synthesis = await runStage3_Synthesis(
    cardAudit ?? makeEmptyStageResult('stage1_failed'),
    photoAudit ?? makeEmptyStageResult('stage2_failed'),
    workspaceId,
    nmId,
    snapshotId,
    cardAudit?.id ?? 0,
    photoAudit?.id ?? 0,
    opts?.shopId ?? null,
  );

  // 5. Compute totals (zeros for failed stages — they contributed nothing)
  const s1Usage = cardAudit?.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const s2Usage = photoAudit?.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const totalTokens = s1Usage.totalTokens + s2Usage.totalTokens + synthesis.usage.totalTokens;

  const totalCost = (
    parseFloat(computeCostUsd(s1Usage.promptTokens, s1Usage.completionTokens)) +
    parseFloat(computeCostUsd(s2Usage.promptTokens, s2Usage.completionTokens)) +
    parseFloat(computeCostUsd(synthesis.usage.promptTokens, synthesis.usage.completionTokens))
  ).toFixed(6);

  // Update totalCostUsd on the final row
  await db
    .update(creativeAuditRunsFinal)
    .set({ totalCostUsd: totalCost, isFree: opts?.isFree ?? true })
    .where(eq(creativeAuditRunsFinal.id, synthesis.id));

  return {
    finalAudit: {
      ...(synthesis.finalAudit as Record<string, unknown>),
      photos: photoAudit ? extractPhotosFromStage2(photoAudit.auditJson, snapshot.photoUrls) : [],
      seo: cardAudit ? extractSeoFromStage1(cardAudit.auditJson) : null,
      partial: !cardAudit || !photoAudit
        ? { stage1Failed: !cardAudit, stage2Failed: !photoAudit }
        : undefined,
      tokenUsage: {
        total: totalTokens,
        costUsd: totalCost,
        breakdown: {
          stage1: s1Usage.totalTokens,
          stage2: s2Usage.totalTokens,
          stage3: synthesis.usage.totalTokens,
        },
      },
    },
    meta: {
      snapshotId,
      cardAuditId: cardAudit?.id ?? 0,
      photoAuditId: photoAudit?.id ?? 0,
      finalAuditId: synthesis.id,
      totalCost,
      totalTokens,
    },
  };
}
