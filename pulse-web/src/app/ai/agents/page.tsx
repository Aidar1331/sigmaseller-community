'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { AgentStatusBadge, type AgentName } from '@/components/ai/AgentStatusBadge';
import { Bot, TrendingUp, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

interface OverviewRun {
  agentName: string | null;
  total: number;
  succeeded: number;
  failed: number;
  avgTokensIn: number;
  avgTokensOut: number;
  totalCostUsd: number;
}

interface OverviewAction {
  agentName: string | null;
  total: number;
  executed: number;
  failed: number;
  rejected: number;
}

interface VerifStat {
  checkType: string;
  total: number;
  passed: number;
  drifted: number;
  failed: number;
  pending: number;
}

const KNOWN_AGENTS: AgentName[] = ['pricing', 'reviews', 'ads', 'supply', 'seo', 'chat', 'fbs'];

export default function AgentsDashboardPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const [window, setWindow] = useState<'7d' | '30d'>('7d');
  const [runs, setRuns] = useState<OverviewRun[]>([]);
  const [actions, setActions] = useState<OverviewAction[]>([]);
  const [verif, setVerif] = useState<VerifStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch(`/agent-metrics/${workspaceId}/overview?window=${window}`),
      apiFetch(`/agent-metrics/${workspaceId}/verification?window=${window}`),
    ])
      .then(async ([ov, ve]) => {
        const o = await ov.json();
        const v = await ve.json();
        setRuns(Array.isArray(o.runs) ? o.runs : []);
        setActions(Array.isArray(o.actions) ? o.actions : []);
        setVerif(Array.isArray(v.byCheckType) ? v.byCheckType : []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [workspaceId, window]);

  const agentCards = KNOWN_AGENTS.map((name) => {
    const run = runs.find((r) => r.agentName === name);
    const act = actions.find((a) => a.agentName === name);
    const acceptanceRate = act && act.total > 0 ? Math.round((act.executed / act.total) * 100) : null;
    return { name, run, act, acceptanceRate };
  });

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bot className="w-7 h-7 text-violet-600" />
            <div>
              <h1 className="text-2xl font-bold">Мульти-агентный дашборд</h1>
              <p className="text-sm text-gray-500">Статус и метрики доменных AI-агентов</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex border rounded-md">
              <button
                className={`px-3 py-1 text-sm ${window === '7d' ? 'bg-violet-100 text-violet-700' : 'text-gray-600'}`}
                onClick={() => setWindow('7d')}
              >
                7 дней
              </button>
              <button
                className={`px-3 py-1 text-sm ${window === '30d' ? 'bg-violet-100 text-violet-700' : 'text-gray-600'}`}
                onClick={() => setWindow('30d')}
              >
                30 дней
              </button>
            </div>
          </div>
        </header>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 p-3 rounded-md text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>Ошибка загрузки: {error}</span>
          </div>
        )}

        {loading ? (
          <Card><div className="p-6 text-gray-500">Загрузка…</div></Card>
        ) : (
          <>
            {/* Agents grid */}
            <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {agentCards.map(({ name, run, act, acceptanceRate }) => (
                <Card key={name} className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <AgentStatusBadge agentName={name} size="md" />
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-gray-500 text-xs">Запусков</div>
                      <div className="text-xl font-semibold">{run?.total ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">Действий</div>
                      <div className="text-xl font-semibold">{act?.total ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">Принято</div>
                      <div className="text-xl font-semibold text-emerald-600">
                        {acceptanceRate != null ? `${acceptanceRate}%` : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">Стоимость</div>
                      <div className="text-xl font-semibold">
                        ${run?.totalCostUsd ? run.totalCostUsd.toFixed(2) : '0.00'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2 text-xs">
                    <Link
                      href={`/settings/agents/${name}`}
                      className="text-violet-600 hover:underline"
                    >
                      Правила →
                    </Link>
                  </div>
                </Card>
              ))}
            </section>

            {/* Verification stats */}
            <Card className="p-4">
              <h2 className="font-semibold mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-violet-600" />
                V&V по уровням
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2">Уровень</th>
                      <th className="py-2 text-right">Всего</th>
                      <th className="py-2 text-right">
                        <span className="inline-flex items-center gap-1"><CheckCircle className="w-3 h-3 text-emerald-500" />Passed</span>
                      </th>
                      <th className="py-2 text-right">
                        <span className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-500" />Drift</span>
                      </th>
                      <th className="py-2 text-right">
                        <span className="inline-flex items-center gap-1"><XCircle className="w-3 h-3 text-red-500" />Failed</span>
                      </th>
                      <th className="py-2 text-right">Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verif.length === 0 ? (
                      <tr><td colSpan={6} className="py-4 text-center text-gray-500">Нет данных</td></tr>
                    ) : verif.map((v) => (
                      <tr key={v.checkType} className="border-b last:border-b-0">
                        <td className="py-2 font-mono text-xs">{v.checkType}</td>
                        <td className="py-2 text-right">{v.total}</td>
                        <td className="py-2 text-right text-emerald-600">{v.passed}</td>
                        <td className="py-2 text-right text-amber-700">{v.drifted}</td>
                        <td className="py-2 text-right text-red-600">{v.failed}</td>
                        <td className="py-2 text-right text-gray-500">{v.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
