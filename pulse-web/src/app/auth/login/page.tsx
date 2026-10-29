import { redirect } from 'next/navigation';
import { authEntryHref } from '@/lib/authEntry';

export default async function AuthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(authEntryHref('login', (await searchParams).returnTo));
}
