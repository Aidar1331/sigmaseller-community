'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AiPageContent } from '@/components/ai/AiPageContent';

export default function AiConversationPage() {
  const params = useParams();
  const raw = params?.conversationId;
  const id = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return (
    <Suspense fallback={null}>
      <AiPageContent initialConversationId={Number.isFinite(id) && id > 0 ? id : undefined} />
    </Suspense>
  );
}
