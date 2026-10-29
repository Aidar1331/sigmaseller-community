'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { AgentStatusBadge, type AgentName } from '@/components/ai/AgentStatusBadge';
import { Save, Plus, Trash2, AlertTriangle, CheckCircle } from 'lucide-react';

interface DomainRule {
  ruleId: number;
  workspaceId: number;
  shopId: number | null;
  agentName: string;
  scopeType: 'global' | 'category' | 'nmid_list';
  scopeValue: unknown;
  ruleYaml: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const PRESETS: Record<string, string> = {
  pricing: `# Pricing Agent rules
min_margin_pct: 15
max_price_change_pct: 20
competitor_threshold: 5
strategy: balanced
oos_price_bump:
  enabled: true
  days_to_oos_threshold: 7
  bump_pct: 10
exclude_nmids: []`,
  ads: `# Ads Agent rules
target_drr_pct: 15
max_cpm: 250
daily_budget_cap_rub: 50000
auto_pause_if:
  drr_above: 40
  no_orders_days: 7
strategy: balanced`,
  reviews: `# Reviews Agent rules
tone_of_voice: professional_warm
autonomous_reply:
  enabled_for_ratings: [5]
  min_text_length: 10
  max_reply_length: 300
auto_pin:
  enabled: true
  max_pinned: 5`,
  supply: `# Supply Agent rules
min_days_buffer_oos: 14
max_acceptance_coefficient: 3
preferred_warehouses: ["Коледино", "Казань"]
min_supply_value_rub: 50000`,
  seo: `# SEO Agent rules
title_max_length: 60
description_max_length: 2000
target_keyword_density: [2, 4]
brand_in_title: true
update_frequency_days: 14`,
  chat: `# Chat Agent rules
tone_of_voice: friendly
requires_human_pickup_for:
  - price_negotiation
  - custom_orders`,
  fbs: `# FBS Agent rules
auto_confirm:
  enabled: true
  max_order_value_rub: 10000
escalate_to_kanban_if:
  order_age_minutes: 45`,
};

const VALID_AGENTS = new Set<AgentName>(['pricing', 'reviews', 'ads', 'supply', 'seo', 'chat', 'fbs']);

export default function AgentRulesEditorPage() {
  const params = useParams<{ name: string }>();
  // Defence-in-depth: validate the URL-derived agent name against the known
  // enum before using it as a query/post param or PRESETS lookup key. The
  // backend zod-enum is the canonical guard, but blocking nonsense early
  // avoids extra round-trips and (less importantly) keeps Sentry quieter.
  const rawName = params.name ?? 'pricing';
  const agentName: AgentName = VALID_AGENTS.has(rawName as AgentName) ? (rawName as AgentName) : 'pricing';
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  const [rules, setRules] = useState<DomainRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editorText, setEditorText] = useState<string>('');
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);

  const loadRules = async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/agent-rules/${workspaceId}?agentName=${agentName}`);
      const data = await res.json();
      setRules(Array.isArray(data.rules) ? data.rules : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentName]);

  const startNew = () => {
    setEditingRuleId(null);
    setEditorText(PRESETS[agentName] ?? '# New rule\n');
    setFlash(null);
  };

  const startEdit = (rule: DomainRule) => {
    setEditingRuleId(rule.ruleId);
    setEditorText(rule.ruleYaml);
    setFlash(null);
  };

  const save = async () => {
    if (!workspaceId || !editorText.trim()) return;
    setError(null);
    setFlash(null);
    try {
      if (editingRuleId == null) {
        const res = await apiFetch(`/agent-rules/${workspaceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentName, ruleYaml: editorText, scopeType: 'global', enabled: true }),
        });
        if (!res.ok) throw new Error(`POST failed: ${res.status}`);
      } else {
        const res = await apiFetch(`/agent-rules/${workspaceId}/${editingRuleId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ruleYaml: editorText }),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
      }
      setFlash('Сохранено ✓');
      await loadRules();
      setEditingRuleId(null);
      setEditorText('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEnabled = async (rule: DomainRule) => {
    try {
      const res = await apiFetch(`/agent-rules/${workspaceId}/${rule.ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
      await loadRules();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteRule = async (rule: DomainRule) => {
    if (!confirm('Удалить правило?')) return;
    try {
      const res = await apiFetch(`/agent-rules/${workspaceId}/${rule.ruleId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`DELETE failed: ${res.status}`);
      await loadRules();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <AppShell>
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AgentStatusBadge agentName={agentName} size="md" />
            <h1 className="text-xl font-bold">Правила агента</h1>
          </div>
          <Button onClick={startNew} variant="primary">
            <Plus className="w-4 h-4 mr-1" /> Новое правило
          </Button>
        </header>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 p-3 rounded-md text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}
        {flash && (
          <div className="flex items-center gap-2 bg-emerald-50 text-emerald-700 p-3 rounded-md text-sm">
            <CheckCircle className="w-4 h-4" />
            <span>{flash}</span>
          </div>
        )}

        {/* Editor */}
        {editorText && (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">{editingRuleId ? `Редактирование правила #${editingRuleId}` : 'Новое правило (YAML)'}</h2>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => { setEditorText(''); setEditingRuleId(null); }}>
                  Отмена
                </Button>
                <Button onClick={save}>
                  <Save className="w-4 h-4 mr-1" /> Сохранить
                </Button>
              </div>
            </div>
            <textarea
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              rows={16}
              className="w-full font-mono text-sm p-3 border rounded-md bg-gray-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-violet-500"
              spellCheck={false}
            />
            <p className="text-xs text-gray-500 mt-2">
              YAML парсится на бэкенде; domain-валидация применяется при вызове агента.
            </p>
          </Card>
        )}

        {/* Existing rules */}
        <Card className="p-4">
          <h2 className="font-semibold mb-3">Существующие правила ({rules.length})</h2>
          {loading ? (
            <div className="text-gray-500 text-sm">Загрузка…</div>
          ) : rules.length === 0 ? (
            <div className="text-gray-500 text-sm">Пока нет правил для агента. Нажмите "Новое правило" с шаблоном.</div>
          ) : (
            <div className="space-y-2">
              {rules.map((r) => (
                <div key={r.ruleId} className="border rounded-md p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-gray-100 px-2 py-0.5 rounded">#{r.ruleId}</span>
                      <span className="text-xs text-gray-500">{r.scopeType}</span>
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input type="checkbox" checked={r.enabled} onChange={() => toggleEnabled(r)} />
                        enabled
                      </label>
                    </div>
                    <div className="flex gap-1">
                      <button className="text-xs text-violet-600 hover:underline" onClick={() => startEdit(r)}>
                        Править
                      </button>
                      <button className="text-xs text-red-600 hover:underline" onClick={() => deleteRule(r)}>
                        <Trash2 className="w-3 h-3 inline" />
                      </button>
                    </div>
                  </div>
                  <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto">{r.ruleYaml}</pre>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
