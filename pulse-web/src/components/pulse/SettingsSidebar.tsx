'use client';

import { useState, useMemo } from 'react';
import { METRIC_MAP, DEFAULT_ENABLED_METRICS, METRIC_GROUPS, METRIC_GROUP_MAP, ALL_METRIC_IDS } from '@/lib/metricMap';
import type { Overview } from '@/types/pulse';
import type { PulsePreset } from '@/lib/presets';
import { Button } from '@/components/ui/Button';
import { MultiSelectCombobox } from '@/components/ui/Combobox';
import { Switch } from '@/components/ui/Switch';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { X, ChevronDown, ChevronRight, Save, Plus, Search, Hash, Barcode } from 'lucide-react';

export type SettingsSidebarProps = {
  open: boolean;
  onClose: () => void;
  // Workspace
  workspaceId: number;
  // Product search by nmId
  nmIds: string;
  onNmIdsChange: (v: string) => void;
  // Filters (multi-select)
  filterVendorCodes: string[];
  filterBrandNames: string[];
  filterSubjectNames: string[];
  onFilterVendorCodesChange: (v: string[]) => void;
  onFilterBrandNamesChange: (v: string[]) => void;
  onFilterSubjectNamesChange: (v: string[]) => void;
  // Autocomplete suggestions
  suggestBrands?: string[];
  suggestVendorCodes?: string[];
  suggestSubjects?: string[];
  suggestNmIds?: string[];
  suggestBarcodes?: string[];
  // Barcode filter
  filterBarcodes?: string[];
  onFilterBarcodesChange?: (v: string[]) => void;
  // DRR
  drrBase: 'sales' | 'payout';
  onDrrBaseChange: (v: 'sales' | 'payout') => void;
  overview: Overview | null;
  // Metrics (catalogGroups and catalog are no longer used - we use static groups)
  catalogGroups?: any[];
  catalog?: any[];
  enabledMetrics: string[];
  onEnabledMetricsChange: (fn: (prev: string[]) => string[]) => void;
  // Presets
  presets: PulsePreset[];
  presetId: number | null;
  isDirty: boolean;
  onSelectPreset: (idStr: string) => void;
  onSavePreset: () => void;
  onSaveAsNewPreset: () => void;
  // Inline preset creation
  onCreatePresetInline?: (name: string) => void;
  onDeletePreset?: (id: number) => void;
};

export function SettingsSidebar(props: SettingsSidebarProps) {
  const {
    open, onClose,
    workspaceId,
    nmIds, onNmIdsChange,
    filterVendorCodes, filterBrandNames, filterSubjectNames,
    onFilterVendorCodesChange, onFilterBrandNamesChange, onFilterSubjectNamesChange,
    suggestBrands, suggestVendorCodes, suggestSubjects, suggestNmIds, suggestBarcodes,
    filterBarcodes, onFilterBarcodesChange,
    drrBase, onDrrBaseChange, overview,
    enabledMetrics, onEnabledMetricsChange,
    presets, presetId, isDirty, onSelectPreset, onSavePreset, onSaveAsNewPreset,
  } = props;

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['core']));
  const [newPresetName, setNewPresetName] = useState('');

  // Parse nmIds string to array for MultiSelectCombobox
  const nmIdsArray = useMemo(() => {
    if (!nmIds.trim()) return [];
    return nmIds.split(',').map(s => s.trim()).filter(Boolean);
  }, [nmIds]);

  const handleNmIdsChange = (values: string[]) => {
    onNmIdsChange(values.join(','));
  };

  if (!open) return null;

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      <div className="fixed right-0 top-0 z-50 flex h-full w-[400px] max-w-[90vw] flex-col border-l border-[var(--card-border)] bg-[var(--card-bg)] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--card-border)] px-5 py-3">
          <span className="text-sm font-semibold text-[var(--content-text)]">Фильтры и метрики</span>
          <button onClick={onClose} className="rounded-md p-1 text-[var(--content-muted)] hover:bg-slate-100 hover:text-[var(--content-text)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* ─── Presets ─── */}
          <Section title="Сохранённые фильтры">
            {/* Inline create new preset */}
            {presets.length >= 10 ? (
              <div className="mb-3 text-xs text-[var(--content-muted)] text-center py-1.5 rounded-md bg-slate-50">
                Максимум 10 фильтров. Удалите неиспользуемые.
              </div>
            ) : (
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPresetName.trim()) {
                    if (props.onCreatePresetInline) {
                      props.onCreatePresetInline(newPresetName.trim());
                    } else {
                      onSaveAsNewPreset();
                    }
                    setNewPresetName('');
                  }
                }}
                placeholder="Название фильтра..."
                className="flex-1 text-xs px-2.5 py-1.5 rounded-md border border-[var(--card-border)] bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300"
              />
              <button
                type="button"
                onClick={() => {
                  if (newPresetName.trim()) {
                    if (props.onCreatePresetInline) {
                      props.onCreatePresetInline(newPresetName.trim());
                    } else {
                      onSaveAsNewPreset();
                    }
                    setNewPresetName('');
                  }
                }}
                disabled={!newPresetName.trim()}
                className="text-xs px-3 py-1.5 rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Save className="h-3.5 w-3.5 inline mr-1" />Сохранить
              </button>
            </div>
            )}

            {/* List of saved presets */}
            {presets.length > 0 ? (
              <div className="space-y-1">
                {presets.map((p) => {
                  const isActive = presetId === p.presetId;
                  return (
                    <div key={p.presetId} className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => onSelectPreset(String(p.presetId))}
                        className={cn(
                          'flex-1 text-left px-2.5 py-1.5 rounded-md truncate transition-colors',
                          isActive ? 'bg-indigo-50 text-indigo-700 font-medium' : 'bg-slate-50 hover:bg-slate-100 text-[var(--content-text)]'
                        )}
                      >
                        {p.name}
                      </button>
                      {isDirty && isActive && (
                        <button
                          type="button"
                          onClick={onSavePreset}
                          title="Сохранить изменения"
                          className="p-1 rounded text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50"
                        >
                          <Save className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {props.onDeletePreset && (
                        <button
                          type="button"
                          onClick={() => props.onDeletePreset!(p.presetId)}
                          title="Удалить фильтр"
                          className="p-1 rounded text-red-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-[var(--content-muted)] text-center py-2">
                Нет сохранённых фильтров
              </div>
            )}

            {/* Reset to no preset */}
            {presetId != null && (
              <button
                type="button"
                onClick={() => onSelectPreset('__none__')}
                className="mt-2 text-[11px] text-[var(--content-muted)] hover:text-[var(--content-text)] hover:underline"
              >
                Сбросить фильтр
              </button>
            )}
          </Section>

          {/* ─── Filters ─── */}
          <Section title="Фильтры товаров">
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-medium text-[var(--content-muted)] mb-1">
                  <Hash className="inline h-3 w-3 mr-1" />
                  Артикул WB (nmId)
                </label>
                <MultiSelectCombobox 
                  options={suggestNmIds ?? []} 
                  value={nmIdsArray} 
                  onValueChange={handleNmIdsChange}
                  placeholder="Например: 382872764"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[var(--content-muted)] mb-1">
                  <Search className="inline h-3 w-3 mr-1" />
                  Артикул продавца
                </label>
                <MultiSelectCombobox 
                  options={suggestVendorCodes ?? []} 
                  value={filterVendorCodes} 
                  onValueChange={onFilterVendorCodesChange} 
                  placeholder="Например: BK216-04" 
                />
              </div>
              {onFilterBarcodesChange && (
                <div>
                  <label className="block text-[11px] font-medium text-[var(--content-muted)] mb-1">
                    <Barcode className="inline h-3 w-3 mr-1" />
                    Штрихкод
                  </label>
                  <MultiSelectCombobox 
                    options={suggestBarcodes ?? []} 
                    value={filterBarcodes ?? []} 
                    onValueChange={onFilterBarcodesChange} 
                    placeholder="Например: 2037401340555" 
                  />
                </div>
              )}
              <div>
                <label className="block text-[11px] font-medium text-[var(--content-muted)] mb-1">Бренд</label>
                <MultiSelectCombobox 
                  options={suggestBrands ?? []} 
                  value={filterBrandNames} 
                  onValueChange={onFilterBrandNamesChange} 
                  placeholder="Например: Nike" 
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[var(--content-muted)] mb-1">Категория товара</label>
                <MultiSelectCombobox 
                  options={suggestSubjects ?? []} 
                  value={filterSubjectNames} 
                  onValueChange={onFilterSubjectNamesChange} 
                  placeholder="Например: Кулоны" 
                />
              </div>
            </div>
          </Section>

          {/* ─── Metrics catalog (static groups) ─── */}
          <Section title="Метрики для отображения">
            {/* Quick actions */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" onClick={() => onEnabledMetricsChange(() => ALL_METRIC_IDS)}>
                Все ({ALL_METRIC_IDS.length})
              </Button>
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" onClick={() => onEnabledMetricsChange(() => DEFAULT_ENABLED_METRICS)}>
                Базовые
              </Button>
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" onClick={() => onEnabledMetricsChange(() => [])}>
                Очистить
              </Button>
            </div>

            {/* Groups as accordions */}
            {METRIC_GROUPS.map((g) => {
              // Get metrics for this group
              const groupMetrics = ALL_METRIC_IDS
                .filter((id) => METRIC_GROUP_MAP[id] === g.groupId)
                .map((id) => ({ id, ...METRIC_MAP[id]! }));
              
              if (groupMetrics.length === 0) return null;

              const ids = groupMetrics.map((m) => m.id);
              const enabledCount = ids.filter((id) => enabledMetrics.includes(id)).length;
              const expanded = expandedGroups.has(g.groupId);

              return (
                <div key={g.groupId} className="mt-2 rounded-[var(--radius-md)] border border-[var(--card-border)]">
                  {/* Accordion header */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.groupId)}
                    className="flex w-full items-center justify-between px-2.5 py-2 hover:bg-slate-50 transition-colors rounded-t-[var(--radius-md)]"
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--content-text)]">
                      {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      {g.title}
                    </span>
                    <span className="text-[10px] text-[var(--content-muted)]">
                      {enabledCount}/{ids.length}
                    </span>
                  </button>

                  {/* Accordion body */}
                  {expanded && (
                    <div className="border-t border-[var(--card-border)] px-2.5 py-2">
                      {/* All / none quick toggles */}
                      <div className="flex gap-2 mb-2">
                        <button
                          onClick={() => onEnabledMetricsChange((prev) => { const s = new Set(prev); for (const id of ids) s.add(id); return Array.from(s); })}
                          disabled={enabledCount === ids.length}
                          className="text-[10px] text-indigo-600 hover:underline disabled:text-[var(--content-muted)] disabled:no-underline"
                        >все</button>
                        <span className="text-[10px] text-[var(--content-muted)]">·</span>
                        <button
                          onClick={() => onEnabledMetricsChange((prev) => prev.filter((x) => !ids.includes(x)))}
                          disabled={enabledCount === 0}
                          className="text-[10px] text-indigo-600 hover:underline disabled:text-[var(--content-muted)] disabled:no-underline"
                        >нет</button>
                      </div>

                      {/* Metrics with Switch toggles */}
                      <div className="space-y-1">
                        {groupMetrics.map((m) => {
                          const checked = enabledMetrics.includes(m.id);
                          return (
                            <div key={m.id} className="flex items-center justify-between py-0.5">
                              <span className="text-[11px] text-[var(--content-text)]" title={m.description || m.helpText}>
                                {m.title}
                              </span>
                              <Switch
                                checked={checked}
                                onCheckedChange={() =>
                                  onEnabledMetricsChange((prev) =>
                                    checked ? prev.filter((x) => x !== m.id) : [...prev, m.id]
                                  )
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        </div>
      </div>
    </>
  );
}

/* ─── Helpers ─── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-[var(--content-text)]">{title}</div>
      {children}
    </div>
  );
}
