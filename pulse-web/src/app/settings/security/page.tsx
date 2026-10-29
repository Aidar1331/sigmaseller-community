import { AppShell } from '@/components/AppShell';
import { AccountRecoveryForm } from '@/components/AccountRecoveryForm';
export default function Page() { return <AppShell><div className="mx-auto max-w-lg space-y-4 p-4"><h1 className="text-2xl font-semibold">Восстановление доступа</h1><AccountRecoveryForm /></div></AppShell>; }
