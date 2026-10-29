'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Redirect to Events page (reports functionality moved to Events -> Summary tab)
export default function ReportsPage() {
  const router = useRouter();
  
  useEffect(() => {
    router.replace('/events');
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-sm text-gray-500">Перенаправление на События...</div>
    </div>
  );
}
