import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { StartPage } from '@/components/landing/StartPage';
import { getAuthReturnTo } from '@/lib/authEntry';

export default async function IndexPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const returnTo = getAuthReturnTo(query.returnTo);
  // Explicit auth links stay usable with stale cookies or when switching accounts.
  if (query.mode !== 'login' && query.mode !== 'register' && (await cookies()).get('session')?.value) {
    redirect(returnTo ?? '/pulse');
  }
  return <StartPage initialMode={query.mode === 'login' ? 'login' : 'register'} returnTo={returnTo} />;
}
