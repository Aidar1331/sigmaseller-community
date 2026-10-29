'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Search, X, Package } from 'lucide-react';
import { cn } from '@/lib/cn';
import { apiFetch } from '@/lib/api';

interface ProductHit {
  nmId: number;
  vendorCode: string | null;
  title: string | null;
  mainPhotoUrl?: string | null;
}

interface ProductSearchInputProps {
  workspaceId: number;
  /** Comma-separated nmIds string */
  value: string;
  /** Called with comma-separated nmIds */
  onChange: (nmIds: string) => void;
  /** Single selection mode (default: false = multi-select) */
  single?: boolean;
  placeholder?: string;
  className?: string;
  /** Compact mode for smaller spaces */
  compact?: boolean;
}

export function ProductSearchInput({
  workspaceId,
  value,
  onChange,
  single = false,
  placeholder = 'Поиск по названию / артикулу...',
  className,
  compact = false,
}: ProductSearchInputProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [results, setResults] = React.useState<ProductHit[]>([]);
  const [loading, setLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // Parse current value into selected items
  const selected = React.useMemo<number[]>(() => {
    const str = String(value ?? '');
    if (!str.trim()) return [];
    return str
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  }, [value]);

  // Map nmId → display info (from search results or previous data)
  const [infoCache, setInfoCache] = React.useState<Map<number, ProductHit>>(new Map());

  // Debounced search
  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = search.trim();
    if (!q) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = (await apiFetch(
          `/cards/${workspaceId}/search?q=${encodeURIComponent(q)}&limit=20`
        )) as { rows: ProductHit[] };
        setResults(res.rows ?? []);
        // Cache info
        setInfoCache((prev) => {
          const next = new Map(prev);
          for (const r of res.rows ?? []) next.set(r.nmId, r);
          return next;
        });
      } catch (e) {
        console.error('Product search failed:', e);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, workspaceId]);

  function addProduct(hit: ProductHit) {
    if (single) {
      onChange(String(hit.nmId));
      setInfoCache((prev) => new Map(prev).set(hit.nmId, hit));
      setSearch('');
      setResults([]);
      setOpen(false);
      return;
    }
    if (selected.includes(hit.nmId)) return;
    const next = [...selected, hit.nmId];
    onChange(next.join(','));
    setInfoCache((prev) => new Map(prev).set(hit.nmId, hit));
    setSearch('');
    setResults([]);
    inputRef.current?.focus();
  }

  function removeProduct(nmId: number) {
    const next = selected.filter((id) => id !== nmId);
    onChange(next.join(','));
  }

  function chipLabel(nmId: number): string {
    const info = infoCache.get(nmId);
    if (compact) {
      if (info?.vendorCode) return info.vendorCode;
      return String(nmId);
    }
    if (info?.vendorCode && info?.title) return `${info.vendorCode} · ${info.title}`;
    if (info?.title) return `${nmId} · ${info.title}`;
    if (info?.vendorCode) return `${nmId} — ${info.vendorCode}`;
    return String(nmId);
  }

  const filteredResults = results.filter((r) => !selected.includes(r.nmId));

  // For single mode with selection, show the selected item info
  const singleSelected = single && selected.length > 0 ? selected[0] : null;
  const singleInfo = singleSelected ? infoCache.get(singleSelected) : null;

  const showPopover = open && (filteredResults.length > 0 || loading || (search.trim().length > 0 && !loading && filteredResults.length === 0));

  return (
    <PopoverPrimitive.Root open={showPopover} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div
          className={cn(
            'flex min-h-[36px] w-full flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm transition-colors',
            'focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent',
            compact && 'min-h-[32px] py-1 px-2 text-xs',
            className
          )}
        >
          {/* Selected chips (multi-select mode) */}
          {!single && selected.map((nmId) => {
            const info = infoCache.get(nmId);
            return (
              <span
                key={nmId}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 shrink-0',
                  compact ? 'text-[10px]' : 'text-xs'
                )}
              >
                {info?.mainPhotoUrl && (
                  <img
                    src={info.mainPhotoUrl}
                    alt=""
                    className={cn('rounded object-cover', compact ? 'h-4 w-4' : 'h-5 w-5')}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <span className={cn('truncate', compact ? 'max-w-[80px]' : 'max-w-[160px]')}>{chipLabel(nmId)}</span>
                <button
                  type="button"
                  onClick={() => removeProduct(nmId)}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-indigo-100 transition-colors"
                >
                  <X className={cn(compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
                </button>
              </span>
            );
          })}

          {/* Single mode: show selected info */}
          {single && singleSelected && (
            <span className={cn(
              'inline-flex items-center gap-1.5 text-[var(--content-text)] min-w-0 flex-1 overflow-hidden',
              compact ? 'text-xs' : 'text-sm'
            )}>
              {singleInfo?.mainPhotoUrl && (
                <img
                  src={singleInfo.mainPhotoUrl}
                  alt=""
                  className={cn('rounded object-cover shrink-0', compact ? 'h-5 w-5' : 'h-6 w-6')}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              )}
              <span className="font-mono text-[var(--content-muted)] shrink-0">{singleSelected}</span>
              {singleInfo?.vendorCode && (
                <span className="font-medium truncate min-w-0">{singleInfo.vendorCode}</span>
              )}
              {singleInfo?.title && (
                <span className="text-[var(--content-muted)] truncate min-w-0 hidden sm:inline">· {singleInfo.title}</span>
              )}
              <button
                type="button"
                onClick={() => onChange('')}
                className="ml-1 rounded-sm p-0.5 hover:bg-slate-100 transition-colors shrink-0"
              >
                <X className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
              </button>
            </span>
          )}

          {/* Search input */}
          {(!single || !singleSelected) && (
            <div className="relative flex flex-1 items-center min-w-[120px]">
              <Search className={cn('shrink-0 text-[var(--content-muted)] mr-1.5', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                placeholder={selected.length === 0 ? placeholder : 'Выбрать...'}
                className={cn(
                  'w-full bg-transparent text-[var(--content-text)] placeholder:text-[var(--content-muted)] outline-none',
                  compact ? 'text-xs' : 'text-sm'
                )}
              />
            </div>
          )}
        </div>
      </PopoverPrimitive.Anchor>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[100] max-h-72 w-[var(--radix-popover-trigger-width)] min-w-[300px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] py-1 shadow-lg"
        >
          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--content-muted)]">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
              Поиск товаров...
            </div>
          )}
          {!loading && filteredResults.length === 0 && search.trim() && (
            <div className="px-3 py-4 text-center text-xs text-[var(--content-muted)]">
              <Package className="h-5 w-5 mx-auto mb-1 opacity-50" />
              Ничего не найдено
            </div>
          )}
          {filteredResults.map((hit) => (
            <button
              key={hit.nmId}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                addProduct(hit);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-indigo-50"
            >
              {hit.mainPhotoUrl ? (
                <img
                  src={hit.mainPhotoUrl}
                  alt=""
                  className="h-10 w-10 rounded object-cover shrink-0 bg-slate-100"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = '';
                    (e.target as HTMLImageElement).className = 'h-10 w-10 rounded bg-slate-100 shrink-0';
                  }}
                />
              ) : (
                <div className="h-10 w-10 rounded bg-slate-100 shrink-0 flex items-center justify-center">
                  <Package className="h-5 w-5 text-slate-300" />
                </div>
              )}
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-[var(--content-muted)]">{hit.nmId}</span>
                  {hit.vendorCode && (
                    <span className="text-sm font-medium text-[var(--content-text)] truncate">{hit.vendorCode}</span>
                  )}
                </div>
                {hit.title && (
                  <span className="text-xs text-[var(--content-muted)] truncate mt-0.5">{hit.title}</span>
                )}
              </div>
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
