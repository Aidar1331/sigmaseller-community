'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/* ─── Select-style Combobox (existing) ─── */

export interface ComboboxOption {
  value: string;
  label: string;
  image?: string;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
}

export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = 'Выберите...',
  searchPlaceholder = 'Поиск...',
  emptyText = 'Ничего не найдено',
  className,
  disabled,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    );
  }, [options, search]);

  const selected = options.find((o) => o.value === value);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-sm transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            !selected && 'text-[var(--content-muted)]',
            selected && 'text-[var(--content-text)]',
            className
          )}
        >
          <span className="truncate">
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--content-muted)]" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            'z-50 w-[var(--radix-popover-trigger-width)] min-w-[200px] rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        >
          {/* Search input */}
          <div className="flex items-center border-b border-[var(--card-border)] px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 text-[var(--content-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex h-9 w-full bg-transparent text-sm text-[var(--content-text)] placeholder:text-[var(--content-muted)] outline-none"
            />
          </div>

          {/* Options list */}
          <div className="max-h-60 overflow-auto p-1">
            {filtered.length === 0 && (
              <div className="py-6 text-center text-sm text-[var(--content-muted)]">
                {emptyText}
              </div>
            )}
            {filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onValueChange?.(option.value);
                  setOpen(false);
                  setSearch('');
                }}
                className={cn(
                  'relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2 text-sm outline-none',
                  'hover:bg-[var(--filter-active-bg)] hover:text-[var(--filter-active-text)]',
                  option.value === value && 'bg-[var(--filter-active-bg)]'
                )}
              >
                <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                  {option.value === value && <Check className="h-4 w-4 text-indigo-600" />}
                </span>
                {option.image && (
                  <img
                    src={option.image}
                    alt=""
                    className="mr-2 h-6 w-6 rounded object-cover"
                  />
                )}
                <span className="truncate">{option.label}</span>
              </button>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ─── Text-input style Combobox with autocomplete suggestions ─── */

interface ComboboxInputProps {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  className?: string;
}

export function ComboboxInput({ value, onChange, suggestions, placeholder, className }: ComboboxInputProps) {
  const [open, setOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = value.toLowerCase().trim();
    if (!q) return suggestions.slice(0, 50);
    return suggestions.filter((o) => o.toLowerCase().includes(q)).slice(0, 50);
  }, [value, suggestions]);

  const showDropdown = open && filtered.length > 0;

  return (
    <PopoverPrimitive.Root open={showDropdown} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className={cn(
            'flex h-9 w-full rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-sm text-[var(--content-text)] placeholder:text-[var(--content-muted)] transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent',
            className
          )}
        />
      </PopoverPrimitive.Anchor>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[100] max-h-48 w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] py-1 shadow-lg"
        >
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center px-3 py-1.5 text-left text-xs text-[var(--content-text)] hover:bg-indigo-50 hover:text-indigo-700 transition-colors',
                value === opt && 'bg-indigo-50 font-medium text-indigo-700'
              )}
            >
              {opt}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ─── Multi-select Combobox with chips ─── */

interface MultiSelectComboboxProps {
  /** List of available options (plain strings) */
  options: string[];
  /** Currently selected values */
  value: string[];
  /** Called when selection changes */
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function MultiSelectCombobox({
  options,
  value,
  onValueChange,
  placeholder = 'Выберите...',
  className,
}: MultiSelectComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selectedSet = React.useMemo(() => new Set(value), [value]);

  const filtered = React.useMemo(() => {
    const q = search.toLowerCase().trim();
    const opts = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return opts.slice(0, 100);
  }, [options, search]);

  function toggle(opt: string) {
    if (selectedSet.has(opt)) {
      onValueChange(value.filter((v) => v !== opt));
    } else {
      onValueChange([...value, opt]);
    }
  }

  function remove(opt: string) {
    onValueChange(value.filter((v) => v !== opt));
  }

  function selectAll() {
    const all = new Set(value);
    for (const o of filtered) all.add(o);
    onValueChange(Array.from(all));
  }

  function clearAll() {
    onValueChange([]);
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            'flex min-h-[36px] w-full flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-sm transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent',
            className
          )}
        >
          {value.length === 0 && (
            <span className="px-1 text-[var(--content-muted)]">{placeholder}</span>
          )}
          {value.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-0.5 rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700"
            >
              <span className="max-w-[120px] truncate">{v}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    remove(v);
                  }
                }}
                className="ml-0.5 rounded-sm p-0.5 hover:bg-indigo-100 transition-colors cursor-pointer"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </span>
          ))}
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--content-muted)]" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            'z-[100] w-[var(--radix-popover-trigger-width)] min-w-[200px] rounded-[var(--radius-md)] border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        >
          {/* Search */}
          <div className="flex items-center border-b border-[var(--card-border)] px-3">
            <Search className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--content-muted)]" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск..."
              className="flex h-8 w-full bg-transparent text-xs text-[var(--content-text)] placeholder:text-[var(--content-muted)] outline-none"
            />
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-2 border-b border-[var(--card-border)] px-3 py-1.5">
            <button
              type="button"
              onClick={selectAll}
              className="text-[10px] text-indigo-600 hover:underline"
            >
              Выбрать все
            </button>
            <span className="text-[10px] text-[var(--content-muted)]">·</span>
            <button
              type="button"
              onClick={clearAll}
              disabled={value.length === 0}
              className="text-[10px] text-indigo-600 hover:underline disabled:text-[var(--content-muted)] disabled:no-underline"
            >
              Очистить
            </button>
            <span className="ml-auto text-[10px] text-[var(--content-muted)]">
              {value.length} выбр.
            </span>
          </div>

          {/* Options */}
          <div className="max-h-48 overflow-auto p-1">
            {filtered.length === 0 && (
              <div className="py-4 text-center text-xs text-[var(--content-muted)]">
                Ничего не найдено
              </div>
            )}
            {filtered.map((opt) => {
              const checked = selectedSet.has(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={cn(
                    'relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-7 pr-2 text-xs outline-none',
                    'hover:bg-[var(--filter-active-bg)] hover:text-[var(--filter-active-text)]',
                    checked && 'bg-indigo-50/50'
                  )}
                >
                  <span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center">
                    {checked && <Check className="h-3.5 w-3.5 text-indigo-600" />}
                  </span>
                  <span className="truncate">{opt}</span>
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
