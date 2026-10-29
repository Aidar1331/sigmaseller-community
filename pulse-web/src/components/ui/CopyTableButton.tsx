'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/cn';

type Props = {
  headers: string[];
  rows: (string | number | null | undefined)[][];
  className?: string;
};

export function CopyTableButton({ headers, rows, className }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const normalize = (v: unknown): string => {
      if (v == null) return '';
      return String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
    };
    const tsv = [
      headers.map(normalize).join('\t'),
      ...rows.map((r) => r.map(normalize).join('\t')),
    ].join('\n');

    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API may be unavailable (insecure context, permissions)
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Скопировано' : 'Копировать таблицу (TSV для Excel)'}
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors',
        className
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-700" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? 'Скопировано' : 'Копировать'}</span>
    </button>
  );
}
