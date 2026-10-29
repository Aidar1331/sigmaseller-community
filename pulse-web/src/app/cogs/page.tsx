'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

import { apiFetch } from '@/lib/api';
import { getUserIdOrNull } from '@/store/auth';
import { useWorkspaceStore } from '@/store/workspace';
import { useActiveShop } from '@/hooks/useShopParam';
import { Download, Upload, FileSpreadsheet, X, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import * as XLSX from 'xlsx';

function toBase64(buf: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface CoverageResp {
  total: number;
  withCogs: number;
  withoutCogs: number;
  coveragePct: number;
  missingSample: Array<{ nmId: number; vendorCode: string; title: string }>;
}

export default function CogsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const setWorkspaceId = useWorkspaceStore((s) => s.setWorkspaceId);
  const { shopId } = useActiveShop();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [coverage, setCoverage] = useState<CoverageResp | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load coverage
  useEffect(() => {
    if (!workspaceId) { setCoverage(null); return; }
    apiFetch<CoverageResp>(`/cogs/${workspaceId}/coverage`)
      .then(setCoverage)
      .catch((e) => console.error('coverage', e));
  }, [workspaceId, result]);

  function downloadMissingCsv() {
    if (!coverage?.missingSample?.length) return;
    const header = 'nmId,vendorCode,title';
    const lines = coverage.missingSample.map(r =>
      `${r.nmId},"${(r.vendorCode || '').replace(/"/g, '""')}","${(r.title || '').replace(/"/g, '""')}"`
    );
    const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cogs_missing_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function pickFile(picked: File | null) {
    setFile(picked);
    setResult(null);
    setError(null);
  }

  function downloadSkippedCsv() {
    const errs: string[] = Array.isArray(result?.errors) ? result.errors : [];
    if (!errs.length) return;
    const lines = ['error'].concat(errs.map((e) => `"${String(e).replace(/"/g, '""')}"`));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cogs_skipped_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const [templateLoading, setTemplateLoading] = useState(false);

  async function downloadTemplate() {
    if (!workspaceId) {
      // Fallback: empty template if no workspace selected
      const wsData = [
        ['Артикул продавца', 'Номенклатура', 'Название', 'Себестоимость (₽)'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 40 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'COGS');
      XLSX.writeFile(wb, 'cogs_template.xlsx');
      return;
    }

    setTemplateLoading(true);
    try {
      const data = await apiFetch<{
        rows: Array<{ vendorCode: string; nmId: number; title: string; cogsRub: number | null }>;
      }>(`/cogs/${workspaceId}/template`);

      const header = ['Артикул продавца', 'Номенклатура', 'Название', 'Себестоимость (₽)'];
      const rows = data.rows.map((r) => [
        r.vendorCode,
        r.nmId,
        r.title,
        r.cogsRub ?? '',
      ]);
      const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
      ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 40 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'COGS');
      XLSX.writeFile(wb, `cogs_template_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e: any) {
      console.error('template download error', e);
      setError('Не удалось загрузить шаблон: ' + String(e?.message ?? e));
    } finally {
      setTemplateLoading(false);
    }
  }

  async function run(dryRun: boolean) {
    if (!file) return;
    if (!workspaceId) {
      setError('Сначала выберите магазин');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const xlsxBase64 = toBase64(buf);
      const res = await apiFetch('/cogs/import/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...(shopId ? { shopId } : {}), actorUserId: getUserIdOrNull(), xlsxBase64, overwrite: true, dryRun }),
      });
      setResult(res);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Себестоимость">
      <div className="p-6 space-y-4">
        {/* Coverage widget */}
        {coverage && (
          <Card>
            <div className="p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-[var(--content-text)]">Покрытие себестоимостью</div>
                  <div className="mt-1 text-xs text-[var(--content-muted)]">
                    Сколько твоих артикулов учтены в финансовых расчётах.
                  </div>
                </div>
                {coverage.coveragePct < 80 && coverage.withoutCogs > 0 && (
                  <Button variant="neutral" size="sm" onClick={downloadMissingCsv}>
                    <Download className="h-3.5 w-3.5 mr-1" />
                    Скачать список без cogs ({coverage.withoutCogs > 200 ? '200+' : coverage.withoutCogs})
                  </Button>
                )}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-white p-3">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--content-muted)]">Всего артикулов</div>
                  <div className="mt-1 text-2xl font-semibold">{coverage.total}</div>
                </div>
                <div className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-emerald-700">С себестоимостью</div>
                  <div className="mt-1 text-2xl font-semibold text-emerald-700">{coverage.withCogs}</div>
                </div>
                <div className={`rounded-[var(--radius-md)] border p-3 ${coverage.coveragePct >= 80 ? 'border-emerald-200 bg-emerald-50' : coverage.coveragePct >= 50 ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
                  <div className={`text-[10px] uppercase tracking-wider ${coverage.coveragePct >= 80 ? 'text-emerald-700' : coverage.coveragePct >= 50 ? 'text-amber-700' : 'text-red-700'}`}>Покрытие</div>
                  <div className={`mt-1 text-2xl font-semibold ${coverage.coveragePct >= 80 ? 'text-emerald-700' : coverage.coveragePct >= 50 ? 'text-amber-700' : 'text-red-700'}`}>
                    {coverage.coveragePct}%
                  </div>
                  <div className={`text-[10px] mt-0.5 ${coverage.coveragePct >= 80 ? 'text-emerald-700' : coverage.coveragePct >= 50 ? 'text-amber-700' : 'text-red-700'}`}>
                    {coverage.withoutCogs} артикулов без cogs
                  </div>
                </div>
              </div>

              {coverage.coveragePct < 80 && (
                <div className="mt-3 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  ⚠️ Финансовые расчёты по {coverage.withoutCogs} артикулам без себестоимости неточны —
                  чистая прибыль и маржа завышены, потому что не учитывается закупка.
                </div>
              )}
            </div>
          </Card>
        )}

        <Card>
          <div className="p-5">
            <div className="text-sm font-semibold text-[var(--content-text)]">Импорт себестоимости</div>
            <div className="mt-2 text-sm text-[var(--content-muted)]">
              Загрузите xlsx-файл с себестоимостью товаров. Формат: столбцы <code className="text-xs bg-slate-100 px-1 rounded">vendorCode</code> (или <code className="text-xs bg-slate-100 px-1 rounded">nmId</code>) и <code className="text-xs bg-slate-100 px-1 rounded">costRub</code> (себестоимость за единицу в рублях).
            </div>
            <div className="mt-2">
              <Button variant="neutral" size="sm" onClick={downloadTemplate} disabled={templateLoading}>
                <Download className="h-3.5 w-3.5 mr-1" />
                {templateLoading ? 'Загрузка…' : 'Скачать шаблон'}
              </Button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />

            {/* Drop-zone / file picker */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f && f.name.endsWith('.xlsx')) pickFile(f);
              }}
              className={[
                'mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border-2 border-dashed px-6 py-8 text-center transition',
                file
                  ? 'border-emerald-300 bg-emerald-50/50'
                  : dragOver
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-slate-300 bg-slate-50 hover:border-indigo-300 hover:bg-indigo-50/50',
              ].join(' ')}
            >
              {file ? (
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="h-7 w-7 text-emerald-600" />
                  <div className="text-left">
                    <div className="text-sm font-medium text-[var(--content-text)]">{file.name}</div>
                    <div className="text-xs text-[var(--content-muted)]">
                      {(file.size / 1024).toFixed(1)} КБ · готов к импорту
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      pickFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                    title="Убрать файл"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="h-7 w-7 text-slate-400" />
                  <div className="text-sm font-medium text-[var(--content-text)]">
                    Перетащите xlsx-файл сюда или нажмите чтобы выбрать
                  </div>
                  <div className="text-xs text-[var(--content-muted)]">
                    Поддерживается только .xlsx
                  </div>
                </>
              )}
            </div>

            {/* Actions */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="neutral"
                disabled={!file || loading || !workspaceId}
                onClick={() => run(true)}
                title={!workspaceId ? 'Сначала выберите магазин' : 'Проверить файл без сохранения'}
              >
                {loading ? '…' : 'Проверить (dry-run)'}
              </Button>

              <Button
                disabled={!file || loading || !workspaceId}
                onClick={() => run(false)}
                title={!workspaceId ? 'Сначала выберите магазин' : 'Импорт с перезаписью'}
              >
                {loading ? 'Импорт…' : 'Импортировать'}
              </Button>

              {!workspaceId && (
                <div className="text-xs text-amber-700">Сначала выберите магазин</div>
              )}

              {error ? (
                <div className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                  {error}
                </div>
              ) : null}
            </div>

            {/* Result — структурированно, не JSON */}
            {result ? (
              <div className="mt-5 space-y-3">
                {/* Заголовок: dry-run или импорт */}
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-[var(--content-muted)]">
                  {result.dryRun ? 'Проверка файла (изменения не сохранены)' : 'Импорт завершён'}
                </div>

                {/* 4 счётчика */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-white p-3">
                    <div className="text-[10px] uppercase tracking-wider text-[var(--content-muted)]">Всего строк</div>
                    <div className="mt-1 text-2xl font-semibold text-[var(--content-text)]">
                      {result.totalRowsInFile ?? '—'}
                    </div>
                  </div>
                  <div className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 p-3">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" /> Импортировано
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-emerald-700">
                      {result.imported ?? 0}
                    </div>
                  </div>
                  <div className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-amber-700">
                      <AlertTriangle className="h-3 w-3" /> Пропущено
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-amber-700">
                      {result.skipped ?? 0}
                    </div>
                  </div>
                  <div className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 p-3">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-red-700">
                      <XCircle className="h-3 w-3" /> Ошибок
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-red-700">
                      {Array.isArray(result.errors) ? result.errors.length : 0}
                    </div>
                  </div>
                </div>

                {/* Распознанные столбцы */}
                {Array.isArray(result.detectedColumns) && result.detectedColumns.length > 0 && (
                  <div className="text-xs text-[var(--content-muted)]">
                    Распознаны столбцы:{' '}
                    {result.detectedColumns.map((c: string) => (
                      <code
                        key={c}
                        className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-[var(--content-text)]"
                      >
                        {c}
                      </code>
                    ))}
                  </div>
                )}

                {/* Список ошибок — раскрывающийся */}
                {Array.isArray(result.errors) && result.errors.length > 0 && (
                  <div className="rounded-[var(--radius-md)] border border-[var(--card-border)] bg-white">
                    <button
                      type="button"
                      onClick={() => setErrorsExpanded((v) => !v)}
                      className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-[var(--content-text)] hover:bg-slate-50"
                    >
                      <span>
                        {errorsExpanded ? 'Скрыть ошибки' : `Показать ошибки (${result.errors.length})`}
                      </span>
                      <Button
                        variant="neutral"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadSkippedCsv();
                        }}
                      >
                        <Download className="mr-1 h-3.5 w-3.5" />
                        Скачать CSV
                      </Button>
                    </button>
                    {errorsExpanded && (
                      <ul className="max-h-72 overflow-auto border-t border-[var(--card-border)] px-3 py-2 text-xs">
                        {result.errors.map((e: string, i: number) => (
                          <li
                            key={i}
                            className="border-b border-slate-100 py-1.5 font-mono text-[11px] text-[var(--content-muted)] last:border-0"
                          >
                            {e}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Подсказка если skipped > 0 — частая причина устаревшие карточки */}
                {Number(result.skipped) > 0 && (
                  <div className="rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <div className="font-medium">Почему могло пропуститься?</div>
                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                      <li>
                        <code className="rounded bg-amber-100 px-1">vendorCode</code> в файле не совпадает с
                        тем что у WB — типографика, лишний пробел, регистр.
                      </li>
                      <li>Карточка ещё не синхронизирована — попробуйте обновить список карточек.</li>
                      <li>Пустая или некорректная цена (например <code>#REF!</code>).</li>
                    </ul>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
