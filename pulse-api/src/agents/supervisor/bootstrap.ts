// Multi-Agent v2 — bootstrap registers all available domain agents when the
// feature flag is on. Imported once from server.ts at startup. Registration
// has no side effect when ENABLE_MULTI_AGENT=0 (early return).

import { env } from '../../env.js';
import { registerAgent } from './domainAgentRegistry.js';

export function bootstrapDomainAgents(): void {
  if (env.ENABLE_MULTI_AGENT !== '1') return;

  // Phase 1 — Pricing
  registerAgent({
    name: 'pricing',
    description:
      'Управление ценой и скидкой товара: мониторинг конкурентов, маржа, промо-акции, OOS-protection. Делегируй для запросов про цены/скидки/маржу/конкурентов.',
  });

  // Phase 2 — Reviews
  registerAgent({
    name: 'reviews',
    description:
      'Отзывы и вопросы покупателей: анализ sentiment, ответы с учётом tone of voice бренда, эскалация негатива. Делегируй для запросов про отзывы/вопросы/оценки.',
  });

  // Phase 2 — Ads (Bidder)
  registerAgent({
    name: 'ads',
    description:
      'Реклама и ставки WB: управление кампаниями, оптимизация ставок, кластеры, ДРР/ROAS. Делегируй для запросов про рекламу/ставки/кампании.',
  });

  // Phase 3 — Supply (FBO)
  registerAgent({
    name: 'supply',
    description:
      'Поставки FBO: планирование, акцепт-коэффициенты, распределение по складам, trbx/passes. Делегируй для запросов про поставки/остатки/склад.',
  });

  // Phase 3 — SEO/Content: позиции + алерты
  registerAgent({
    name: 'seo',
    description:
      'SEO-мониторинг: алерты падения позиций в поиске, title/description карточек, анализ текущих позиций отслеживаемых keywords. Делегируй для запросов про позиции/карточки/SEO-алерты.',
  });

  // Phase 3 — SEO keyword mining (отдельный tool — subagent_seo_keyword_suggestion)
  registerAgent({
    name: 'seo_keywords',
    toolName: 'subagent_seo_keyword_suggestion',
    description:
      'Поиск НОВЫХ ключевых слов для добавления на отслеживание: mining из wb_search_queries (топ-запросы с трафиком на карточки, не отслеживаемые). Делегируй для запросов "какие слова добавить", "новые ключевые слова", "предложи keywords".',
  });

  // Phase 3 — Chat
  registerAgent({
    name: 'chat',
    description:
      'Чаты покупателей: диалоги, консультации, обработка предпродажных вопросов. Делегируй для запросов про чаты/сообщения покупателей.',
  });

  // Phase 3 — FBS
  registerAgent({
    name: 'fbs',
    description:
      'FBS заказы: подтверждение, маркировка (SGTIN/UIN/GTIN/IMEI), обработка отмен. Делегируй для запросов про FBS/маркировку/заказы-селф.',
  });
}
