'use client';

import { AppShell } from '@/components/AppShell';
import { apiFetch } from '@/lib/api';
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ComboboxInput } from '@/components/ui/Combobox';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/ToggleGroup';
import { cn } from '@/lib/cn';

import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { Plus, RefreshCw, Search, Trash2, Tag, Circle, ChevronRight, Download, X, Check } from 'lucide-react';

type TagType = { tagId: number; name: string; color: string | null };

type ProductRow = {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  brandName?: string | null;
  subjectName?: string | null;
  tags: TagType[];
};

const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#78716c', '#64748b', '#475569', '#1e293b',
];

const PAGE_SIZE = 200;

export default function TagsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const [tab, setTab] = useState<'products' | 'tags'>('products');

  const [tags, setTags] = useState<TagType[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#8b5cf6');

  // Search & filters
  const [q, setQ] = useState('');
  const [filterTagId, setFilterTagId] = useState<string>('__all__');
  const [filterNoTags, setFilterNoTags] = useState(false);
  const [filterBrand, setFilterBrand] = useState('');
  const [filterCategory, setFilterCategory] = useState('');

  const [rows, setRows] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Autocomplete suggestions
  const [suggestNmIds, setSuggestNmIds] = useState<string[]>([]);
  const [suggestBrands, setSuggestBrands] = useState<string[]>([]);
  const [suggestSubjects, setSuggestSubjects] = useState<string[]>([]);

  // Batch selection
  const [selectedNmIds, setSelectedNmIds] = useState<Set<number>>(new Set());
  const [batchTagId, setBatchTagId] = useState<string>('');
  const [batchApplying, setBatchApplying] = useState(false);

  const tagsById = useMemo(() => new Map(tags.map((t) => [t.tagId, t] as const)), [tags]);

  const hasMore = offset + rows.length < total;

  async function loadTags() {
    if (!workspaceId) return; // Guard: wait for workspace to be selected
    setTagsLoading(true);
    setTagsError(null);
    try {
      const res = (await apiFetch(`/tags/${workspaceId}`)) as { rows: TagType[] };
      setTags(res.rows ?? []);
    } catch (e: any) {
      setTagsError(String(e?.message ?? e));
    } finally {
      setTagsLoading(false);
    }
  }

  async function loadDistinct() {
    if (!workspaceId) return; // Guard: wait for workspace
    try {
      const res = (await apiFetch(`/cards/${workspaceId}/distinct`)) as { nmIds?: number[]; brands?: string[]; vendorCodes?: string[]; subjects?: string[] };
      setSuggestNmIds([...(res.nmIds ?? []).map(String), ...(res.vendorCodes ?? [])]);
      setSuggestBrands(res.brands ?? []);
      setSuggestSubjects(res.subjects ?? []);
    } catch (e) { console.error('Failed to load suggestions:', e); }
  }

  async function searchProducts(appendOffset?: number) {
    if (!workspaceId) return; // Guard: wait for workspace
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set('q', q.trim());
      if (filterTagId !== '__all__' && filterTagId !== '__none__') qs.set('tagId', filterTagId);
      if (filterTagId === '__none__' || filterNoTags) qs.set('noTags', '1');
      if (filterBrand.trim()) qs.set('brandName', filterBrand.trim());
      if (filterCategory.trim()) qs.set('subjectName', filterCategory.trim());
      qs.set('limit', String(PAGE_SIZE));
      const off = appendOffset ?? 0;
      qs.set('offset', String(off));

      const res = (await apiFetch(
        `/tags/${workspaceId}/products/search?${qs.toString()}`
      )) as { rows: ProductRow[]; total: number };

      if (off > 0) {
        // Append
        setRows((prev) => [...prev, ...(res.rows ?? [])]);
      } else {
        setRows(res.rows ?? []);
      }
      setTotal(res.total ?? 0);
      setOffset(off);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  function loadMore() {
    const nextOffset = offset + PAGE_SIZE;
    searchProducts(nextOffset);
  }

  async function loadAllProducts() {
    setLoading(true);
    setError(null);
    try {
      // Load all products without filters, page by page
      let allRows: ProductRow[] = [];
      let off = 0;
      let fetchTotal = 0;
      do {
        const qs = new URLSearchParams();
        qs.set('limit', String(PAGE_SIZE));
        qs.set('offset', String(off));
        const res = (await apiFetch(`/tags/${workspaceId}/products/search?${qs.toString()}`)) as { rows: ProductRow[]; total: number };
        allRows = [...allRows, ...(res.rows ?? [])];
        fetchTotal = res.total ?? 0;
        off += PAGE_SIZE;
      } while (allRows.length < fetchTotal && off < 5000); // Safety limit at 5000

      setRows(allRows);
      setTotal(fetchTotal);
      setOffset(0);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function applyBatchTag() {
    if (!batchTagId || selectedNmIds.size === 0) return;
    setBatchApplying(true);
    try {
      const tagIdNum = Number(batchTagId);
      for (const nmId of selectedNmIds) {
        const row = rows.find((r) => r.nmId === nmId);
        const curIds = new Set((row?.tags ?? []).map((t) => t.tagId));
        curIds.add(tagIdNum);
        await apiFetch(`/tags/${workspaceId}/products/${nmId}/set`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagIds: Array.from(curIds) }),
        });
        // Update local state
        const tag = tagsById.get(tagIdNum);
        if (tag) {
          setRows((prev) => prev.map((r) => {
            if (r.nmId !== nmId) return r;
            const has = r.tags.some((t) => t.tagId === tagIdNum);
            if (has) return r;
            return { ...r, tags: [...r.tags, tag] };
          }));
        }
      }
      setSelectedNmIds(new Set());
      setBatchTagId('');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBatchApplying(false);
    }
  }

  function toggleSelectAll() {
    if (selectedNmIds.size === rows.length) {
      setSelectedNmIds(new Set());
    } else {
      setSelectedNmIds(new Set(rows.map((r) => r.nmId)));
    }
  }

  function toggleSelect(nmId: number) {
    setSelectedNmIds((prev) => {
      const next = new Set(prev);
      if (next.has(nmId)) next.delete(nmId);
      else next.add(nmId);
      return next;
    });
  }

  async function createTag() {
    if (!newTagName.trim()) return;
    setTagsError(null);
    try {
      const res = await apiFetch(`/tags/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTagName, color: newTagColor }),
      });
      setNewTagName('');
      await loadTags();
      setTagsError(null);
      // Show success feedback
      setSuccessMsg(`Тег «${newTagName}» создан`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('409') || msg.includes('уже занято') || msg.includes('duplicate')) {
        setTagsError('Тег с таким именем уже существует');
      } else {
        setTagsError(msg);
      }
    }
  }

  async function deleteTag(tagId: number) {
    const tag = tags.find((t) => t.tagId === tagId);
    if (!confirm(`Удалить тег «${tag?.name ?? tagId}»? Тег будет снят со всех товаров.`)) return;
    try {
      await apiFetch(`/tags/${workspaceId}/${tagId}`, { method: 'DELETE' });
      await loadTags();
    } catch (e: any) {
      setTagsError(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    if (successMsg) {
      const t = setTimeout(() => setSuccessMsg(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successMsg]);

  useEffect(() => {
    loadTags();
    loadDistinct();
    // Load products on mount
    searchProducts(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useShopChange(() => {
    loadTags();
    loadDistinct();
    searchProducts(0);
  });

  async function toggleProductTag(nmId: number, tagId: number) {
    const row = rows.find((r) => r.nmId === nmId);
    if (!row) return;
    const cur = new Set((row.tags ?? []).map((t) => t.tagId));
    if (cur.has(tagId)) cur.delete(tagId);
    else cur.add(tagId);

    const nextTags = Array.from(cur)
      .map((id) => tagsById.get(id))
      .filter(Boolean) as TagType[];

    setRows((prev) => prev.map((r) => (r.nmId === nmId ? { ...r, tags: nextTags } : r)));

    try {
      await apiFetch(`/tags/${workspaceId}/products/${nmId}/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: Array.from(cur) }),
      });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  return (
    <AppShell title="Теги">
      {/* Tabs */}
      <div className="mt-4">
        <ToggleGroup type="single" value={tab} onValueChange={(v) => v && setTab(v as 'products' | 'tags')}>
          <ToggleGroupItem value="products">Товары</ToggleGroupItem>
          <ToggleGroupItem value="tags">Теги</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {tab === 'tags' ? (
        <div className="mt-6 grid gap-4">
          {/* Create tag */}
          <Card className="p-4">
            <div className="text-sm font-medium text-[var(--content-text)]">Создать тег</div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="block text-xs font-medium text-[var(--content-muted)]">
                Название
                <Input
                  className="mt-1 w-64"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="например: Хит"
                />
              </label>
              <div>
                <div className="text-xs font-medium text-[var(--content-muted)]">Цвет</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {COLOR_PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewTagColor(c)}
                      className={cn(
                        'h-7 w-7 rounded-md transition-all',
                        newTagColor === c && 'ring-2 ring-offset-2 ring-indigo-500'
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <Button onClick={createTag} disabled={!newTagName.trim()}>
                <Plus className="h-4 w-4" /> Создать
              </Button>
              <Button variant="neutral" onClick={loadTags}>
                <RefreshCw className="h-4 w-4" /> Обновить
              </Button>
            </div>
            {tagsError && <div className="mt-2 text-xs text-red-500">{tagsError}</div>}
            {successMsg && <div className="mt-2 text-xs text-green-700">{successMsg}</div>}
          </Card>

          {/* Tags list */}
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-[var(--content-text)]">Теги</div>
              {tagsLoading && <div className="text-xs text-[var(--content-muted)]">Загрузка...</div>}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {tags.map((t) => (
                <div key={t.tagId} className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--card-border)] px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="h-3 w-1 rounded-full" style={{ backgroundColor: t.color ?? '#64748b' }} />
                    <span className="text-sm font-medium text-[var(--content-text)]">{t.name}</span>
                    <span className="text-xs text-[var(--content-muted)]">#{t.tagId}</span>
                  </div>
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => deleteTag(t.tagId)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {tags.length === 0 && (
                <div className="col-span-2 flex flex-col items-center justify-center py-8 text-center">
                  <Tag className="h-8 w-8 text-[var(--content-muted)]" />
                  <p className="mt-2 text-sm text-[var(--content-muted)]">Пока нет тегов</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {/* Search & filters */}
          <Card className="p-4">
            <div className="text-sm font-medium text-[var(--content-text)]">Поиск и фильтры</div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              {/* Text search */}
              <FilterField label="Поиск (артикул / название)">
                <ComboboxInput
                  value={q}
                  onChange={setQ}
                  suggestions={suggestNmIds}
                  placeholder="Футболка или 382872764"
                />
              </FilterField>

              {/* Tag filter */}
              <FilterField label="Тег">
                <Select value={filterTagId} onValueChange={(v) => { setFilterTagId(v); setFilterNoTags(v === '__none__'); }}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Все товары" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Все товары</SelectItem>
                    <SelectItem value="__none__">Без тегов</SelectItem>
                    {tags.map((t) => (
                      <SelectItem key={t.tagId} value={String(t.tagId)}>
                        <span className="flex items-center gap-2">
                          {t.color && <Circle className="h-2.5 w-2.5 shrink-0" fill={t.color} stroke={t.color} />}
                          {t.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>

              {/* Brand filter */}
              <FilterField label="Бренд">
                <ComboboxInput
                  value={filterBrand}
                  onChange={setFilterBrand}
                  suggestions={suggestBrands}
                  placeholder="Например: Nike"
                />
              </FilterField>

              {/* Category filter */}
              <FilterField label="Категория (предмет)">
                <ComboboxInput
                  value={filterCategory}
                  onChange={setFilterCategory}
                  suggestions={suggestSubjects}
                  placeholder="Например: Футболки"
                />
              </FilterField>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => searchProducts()} disabled={loading} loading={loading}>
                <Search className="h-4 w-4" /> Найти
              </Button>
              <Button variant="neutral" onClick={loadAllProducts} disabled={loading}>
                <Download className="h-4 w-4" /> Показать все товары
              </Button>
              <Button variant="neutral" onClick={loadTags} disabled={tagsLoading}>
                <RefreshCw className="h-4 w-4" /> Обновить теги
              </Button>

              {total > 0 && (
                <span className="ml-auto text-xs text-[var(--content-muted)]">
                  Найдено: {total} товар{total === 1 ? '' : total < 5 ? 'а' : 'ов'}
                  {rows.length < total && ` (показано ${rows.length})`}
                </span>
              )}
            </div>
            {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
          </Card>

          {/* Batch action bar */}
          {selectedNmIds.size > 0 && (
            <Card className="p-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-medium text-[var(--content-text)]">
                  Выбрано: {selectedNmIds.size}
                </span>
                <Select value={batchTagId || '__none__'} onValueChange={(v) => setBatchTagId(v === '__none__' ? '' : v)}>
                  <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder="Выберите тег" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Выберите тег</SelectItem>
                    {tags.map((t) => (
                      <SelectItem key={t.tagId} value={String(t.tagId)}>
                        <span className="flex items-center gap-2">
                          {t.color && <Circle className="h-2.5 w-2.5 shrink-0" fill={t.color} stroke={t.color} />}
                          {t.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={applyBatchTag} disabled={!batchTagId || batchApplying} loading={batchApplying}>
                  <Check className="h-3.5 w-3.5" /> Назначить тег
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedNmIds(new Set())}>
                  <X className="h-3.5 w-3.5" /> Снять выделение
                </Button>
              </div>
            </Card>
          )}

          {/* Products table */}
          <Card className="overflow-hidden p-0">
            <div className="overflow-auto">
              <table className="w-full border-collapse text-xs table-fixed">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-[120px]" />
                  <col />
                  <col className="w-[120px]" />
                  <col className="w-[120px]" />
                  <col className="w-[200px]" />
                </colgroup>
                <thead>
                  <tr className="bg-[var(--table-header-bg)] text-[var(--content-muted)]">
                    <th className="border-b border-[var(--table-border)] p-2.5 text-center w-10">
                      <input
                        type="checkbox"
                        checked={rows.length > 0 && selectedNmIds.size === rows.length}
                        onChange={toggleSelectAll}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                    </th>
                    <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Артикул</th>
                    <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Название</th>
                    <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Бренд</th>
                    <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Категория</th>
                    <th className="border-b border-[var(--table-border)] p-2.5 text-left text-xs font-medium uppercase tracking-wide">Теги</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.nmId} className={cn('transition-colors hover:bg-[var(--table-row-hover)]', selectedNmIds.has(r.nmId) && 'bg-indigo-50/40')}>
                      <td className="border-b border-[var(--table-border)] p-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={selectedNmIds.has(r.nmId)}
                          onChange={() => toggleSelect(r.nmId)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="border-b border-[var(--table-border)] p-2.5">
                        <div className="text-[var(--content-text)] font-medium"><NmIdLink nmId={r.nmId}>{r.vendorCode ?? `WB ${r.nmId}`}</NmIdLink></div>
                        <div className="text-[10px] font-mono text-[var(--content-muted)]"><NmIdLink nmId={r.nmId} /></div>
                      </td>
                      <td className="border-b border-[var(--table-border)] p-2.5 text-[var(--content-muted)] truncate overflow-hidden">{r.title ?? ''}</td>
                      <td className="border-b border-[var(--table-border)] p-2.5 text-[var(--content-muted)]">{r.brandName ?? ''}</td>
                      <td className="border-b border-[var(--table-border)] p-2.5 text-[var(--content-muted)]">{r.subjectName ?? ''}</td>
                      <td className="border-b border-[var(--table-border)] p-2.5">
                        <TagsCell
                          assignedTags={r.tags ?? []}
                          allTags={tags}
                          onToggle={(tagId) => toggleProductTag(r.nmId, tagId)}
                        />
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td className="p-8 text-center text-sm text-[var(--content-muted)]" colSpan={6}>
                        {loading ? 'Загрузка…' : 'Нет результатов. Используйте поиск или нажмите «Загрузить все товары».'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Load more / pagination */}
            {hasMore && (
              <div className="flex items-center justify-center border-t border-[var(--table-border)] p-3">
                <Button variant="neutral" size="sm" onClick={loadMore} loading={loading} disabled={loading}>
                  <ChevronRight className="h-4 w-4" />
                  Показать ещё ({Math.min(PAGE_SIZE, total - rows.length)} из {total - rows.length} оставшихся)
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

/* ─── Helpers ─── */

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-[var(--content-muted)]">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function TagsCell({
  assignedTags,
  allTags,
  onToggle,
}: {
  assignedTags: TagType[];
  allTags: TagType[];
  onToggle: (tagId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const assignedIds = new Set(assignedTags.map((t) => t.tagId));
  const unassigned = allTags.filter((t) => !assignedIds.has(t.tagId));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {assignedTags.length === 0 && !open && (
        <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-[var(--content-muted)] hover:text-indigo-500 hover:underline cursor-pointer" title="Нажмите чтобы добавить тег">
          + Добавить тег
        </button>
      )}
      {assignedTags.map((t) => (
        <span
          key={t.tagId}
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{
            borderColor: t.color ? `${t.color}40` : undefined,
            backgroundColor: t.color ? `${t.color}15` : undefined,
            color: t.color ?? 'var(--content-text)',
          }}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: t.color ?? '#64748b' }} />
          {t.name}
          <button
            type="button"
            onClick={() => onToggle(t.tagId)}
            className="ml-0.5 rounded-full p-0.5 hover:bg-black/10 transition-colors"
            title="Убрать тег"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      {allTags.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--card-border)] text-[var(--content-muted)] hover:bg-slate-50 hover:text-[var(--content-text)] transition-colors"
            title="Добавить тег"
          >
            <Plus className="h-3 w-3" />
          </button>
          {open && unassigned.length > 0 && (
            <div className="absolute left-0 top-7 z-50 min-w-[140px] rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg">
              {unassigned.map((t) => (
                <button
                  key={t.tagId}
                  type="button"
                  onClick={() => { onToggle(t.tagId); setOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--content-text)] hover:bg-slate-50 transition-colors"
                >
                  <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ background: t.color ?? '#64748b' }} />
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
