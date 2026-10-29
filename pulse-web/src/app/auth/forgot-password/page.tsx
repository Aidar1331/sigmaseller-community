import Link from 'next/link';
import { AccountRecoveryForm } from '@/components/AccountRecoveryForm';
export default function Page() { return <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4"><div className="w-full max-w-md space-y-5"><h1 className="text-2xl font-semibold">Восстановление пароля</h1><AccountRecoveryForm reset /><Link href="/auth/login" className="block text-sm text-indigo-600 underline">Вернуться к входу</Link></div></main>; }
