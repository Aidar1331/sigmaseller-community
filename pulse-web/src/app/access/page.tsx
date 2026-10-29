'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /access is deprecated — redirect to /settings/team
 * Team management UI is fully implemented there
 */
export default function AccessPage() {
  const router = useRouter();
  
  useEffect(() => {
    router.replace('/settings/team');
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-sm text-gray-500">Перенаправление...</div>
    </div>
  );
}
