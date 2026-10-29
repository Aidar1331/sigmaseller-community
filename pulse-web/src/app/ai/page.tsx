'use client';

import { Suspense } from 'react';
import { AiPageContent } from '@/components/ai/AiPageContent';

/**
 * AI Agent page — chat with the agent.
 * Default route `/ai` (no specific conversation). For `/ai/[conversationId]`
 * см. соседний файл `[conversationId]/page.tsx`.
 *
 * Suspense wraps AiPageContent because it now reads searchParams (template
 * auto-prompt from /task-monitor) — Next.js requires a suspense boundary
 * when useSearchParams is called during prerender.
 */
export default function AiPage() {
  return (
    <Suspense fallback={null}>
      <AiPageContent />
    </Suspense>
  );
}
