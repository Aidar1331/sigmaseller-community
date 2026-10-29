'use client';

import { useCallback, useEffect, useState } from 'react';
import { Key, Plus, Trash2, X, ListFilter, Ban, Check, Zap } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

// Types
type BidderKeyword = {
  keywordId: number;
  keyword: string;
  listType: 'whitelist' | 'blacklist' | 'auto_minus';
  campaignId: number | null;
  source: 'manual' | 'auto';
  reason: string | null;
  isActive: boolean;
  createdAt: string;
};

type AutoRule = {
  ruleId: number;
  name: string;
  isActive: boolean;
  minImpressions: number;
  minDays: number;
  maxConversions: number;
  maxDrrPct: number | null;
  minCtrPct: number | null;
  notifyOnly: boolean;
};

type Props = {
  workspaceId: number;
  onClose: () => void;
};

export function BidderKeywords({ workspaceId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'whitelist' | 'blacklist' | 'rules'>('whitelist');
  const [error, setError] = useState<string | null>(null);

  // Keywords
  const [keywords, setKeywords] = useState<BidderKeyword[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [bulkKeywords, setBulkKeywords] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  
  // Auto-rules
  const [rules, setRules] = useState<AutoRule[]>([]);
  const [newRule, setNewRule] = useState({
    name: '',
    minImpressions: 100,
    maxConversions: 0,
    maxDrrPct: '',
    minCtrPct: '',
  });

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const [kw, r] = await Promise.all([
        apiFetch(`/bidder/${workspaceId}/keywords`) as Promise<BidderKeyword[]>,
        apiFetch(`/bidder/${workspaceId}/keyword-rules`) as Promise<AutoRule[]>,
      ]);
      setKeywords(kw);
      setRules(r);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить ключевые слова');
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Add keyword
  const handleAddKeyword = async (listType: 'whitelist' | 'blacklist') => {
    if (!newKeyword.trim()) return;
    try {
      await apiFetch(`/bidder/${workspaceId}/keywords`, {
        method: 'POST',
        body: JSON.stringify({ keyword: newKeyword.trim(), listType }),
      });
      setNewKeyword('');
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить слово');
    }
  };

  // Bulk add
  const handleBulkAdd = async (listType: 'whitelist' | 'blacklist') => {
    const keywords = bulkKeywords
      .split('\n')
      .map(k => k.trim())
      .filter(k => k.length > 0);
    if (keywords.length === 0) return;

    try {
      await apiFetch(`/bidder/${workspaceId}/keywords/bulk`, {
        method: 'POST',
        body: JSON.stringify({ keywords, listType }),
      });
      setBulkKeywords('');
      setShowBulk(false);
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось добавить слова списком');
    }
  };

  // Delete keyword
  const handleDeleteKeyword = async (keywordId: number) => {
    try {
      await apiFetch(`/bidder/${workspaceId}/keywords/${keywordId}`, { method: 'DELETE' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить слово');
    }
  };

  // Add rule
  const handleAddRule = async () => {
    if (!newRule.name) return;
    try {
      await apiFetch(`/bidder/${workspaceId}/keyword-rules`, {
        method: 'POST',
        body: JSON.stringify({
          name: newRule.name,
          minImpressions: newRule.minImpressions,
          maxConversions: newRule.maxConversions,
          maxDrrPct: newRule.maxDrrPct ? Number(newRule.maxDrrPct) : null,
          minCtrPct: newRule.minCtrPct ? Number(newRule.minCtrPct) : null,
        }),
      });
      setNewRule({ name: '', minImpressions: 100, maxConversions: 0, maxDrrPct: '', minCtrPct: '' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось создать правило');
    }
  };

  // Delete rule
  const handleDeleteRule = async (ruleId: number) => {
    try {
      await apiFetch(`/bidder/${workspaceId}/keyword-rules/${ruleId}`, { method: 'DELETE' });
      setError(null);
      fetchData();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось удалить правило');
    }
  };

  const whitelist = keywords.filter(k => k.listType === 'whitelist');
  const blacklist = keywords.filter(k => k.listType === 'blacklist' || k.listType === 'auto_minus');

  const tabs = [
    { id: 'whitelist' as const, label: 'Белый список', icon: Check, count: whitelist.length },
    { id: 'blacklist' as const, label: 'Минус-слова', icon: Ban, count: blacklist.length },
    { id: 'rules' as const, label: 'Авто-правила', icon: Zap, count: rules.length },
  ];

  return (
    <Card className="p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-muted/30">
        <h3 className="font-semibold flex items-center gap-2">
          <Key className="h-5 w-5" />
          Управление ключевыми словами
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
            <Badge variant="neutral" className="ml-1">{tab.count}</Badge>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4">
        {error && (
          <div className="mb-3">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        )}
        {/* Whitelist Tab */}
        {activeTab === 'whitelist' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Реклама будет показываться ТОЛЬКО по этим ключевым словам
            </p>
            
            {/* Add form */}
            <div className="flex gap-2">
              <Input
                placeholder="Добавить ключевое слово"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword('whitelist')}
                className="flex-1"
              />
              <Button onClick={() => handleAddKeyword('whitelist')} disabled={!newKeyword.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
              <Button variant="neutral" onClick={() => setShowBulk(!showBulk)}>
                <ListFilter className="h-4 w-4" />
              </Button>
            </div>

            {showBulk && (
              <div className="space-y-2">
                <textarea
                  placeholder="Вставьте ключевые слова (каждое с новой строки)"
                  value={bulkKeywords}
                  onChange={(e) => setBulkKeywords(e.target.value)}
                  className="w-full h-24 p-2 border rounded text-sm"
                />
                <Button onClick={() => handleBulkAdd('whitelist')} disabled={!bulkKeywords.trim()}>
                  Добавить все
                </Button>
              </div>
            )}

            {/* List */}
            <div className="flex flex-wrap gap-2">
              {whitelist.map((kw) => (
                <Badge key={kw.keywordId} variant="neutral" className="flex items-center gap-1 pr-1">
                  <Check className="h-3 w-3 text-green-500" />
                  {kw.keyword}
                  <button
                    onClick={() => handleDeleteKeyword(kw.keywordId)}
                    className="ml-1 hover:bg-black/20 rounded p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {whitelist.length === 0 && (
                <p className="text-sm text-muted-foreground">Белый список пуст</p>
              )}
            </div>
          </div>
        )}

        {/* Blacklist Tab */}
        {activeTab === 'blacklist' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              По этим словам реклама показываться НЕ будет
            </p>
            
            {/* Add form */}
            <div className="flex gap-2">
              <Input
                placeholder="Добавить минус-слово"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword('blacklist')}
                className="flex-1"
              />
              <Button onClick={() => handleAddKeyword('blacklist')} disabled={!newKeyword.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
              <Button variant="neutral" onClick={() => setShowBulk(!showBulk)}>
                <ListFilter className="h-4 w-4" />
              </Button>
            </div>

            {showBulk && (
              <div className="space-y-2">
                <textarea
                  placeholder="Вставьте минус-слова (каждое с новой строки)"
                  value={bulkKeywords}
                  onChange={(e) => setBulkKeywords(e.target.value)}
                  className="w-full h-24 p-2 border rounded text-sm"
                />
                <Button onClick={() => handleBulkAdd('blacklist')} disabled={!bulkKeywords.trim()}>
                  Добавить все
                </Button>
              </div>
            )}

            {/* List */}
            <div className="flex flex-wrap gap-2">
              {blacklist.map((kw) => (
                <Badge key={kw.keywordId} variant="danger" className="flex items-center gap-1 pr-1">
                  <Ban className="h-3 w-3" />
                  {kw.keyword}
                  {kw.source === 'auto' && (
                    <span className="text-xs opacity-70">(авто)</span>
                  )}
                  <button
                    onClick={() => handleDeleteKeyword(kw.keywordId)}
                    className="ml-1 hover:bg-black/20 rounded p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              {blacklist.length === 0 && (
                <p className="text-sm text-muted-foreground">Минус-слов нет</p>
              )}
            </div>
          </div>
        )}

        {/* Rules Tab */}
        {activeTab === 'rules' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Правила автоматического добавления в минус-слова
            </p>
            
            {/* Add rule form */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5 items-end">
              <div>
                <label className="text-xs text-muted-foreground">Название</label>
                <Input
                  placeholder="Без конверсий"
                  value={newRule.name}
                  onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Мин. показов</label>
                <Input
                  type="number"
                  value={newRule.minImpressions}
                  onChange={(e) => setNewRule({ ...newRule, minImpressions: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Макс. конверсий</label>
                <Input
                  type="number"
                  value={newRule.maxConversions}
                  onChange={(e) => setNewRule({ ...newRule, maxConversions: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Макс. ДРР %</label>
                <Input
                  type="number"
                  placeholder="30"
                  value={newRule.maxDrrPct}
                  onChange={(e) => setNewRule({ ...newRule, maxDrrPct: e.target.value })}
                />
              </div>
              <Button onClick={handleAddRule} disabled={!newRule.name}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {/* Rules list */}
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.ruleId} className="flex items-center justify-between p-3 bg-muted/50 rounded">
                  <div>
                    <div className="font-medium">{rule.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {rule.minImpressions} показов, {rule.maxConversions} конверсий
                      {rule.maxDrrPct != null && `, ДРР > ${rule.maxDrrPct}%`}
                      {rule.minCtrPct != null && `, CTR < ${rule.minCtrPct / 100}%`}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteRule(rule.ruleId)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))}
              {rules.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Нет правил</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
