/**
 * Universal export for tables → Excel (.xlsx) and PDF.
 *
 * Используется из `<ExportButton />` (AI-чат и любые UI-страницы). Одна
 * реализация на всё приложение — не копипастим логику в каждый компонент.
 *
 * PDF поддерживает кириллицу через DejaVu Sans TTF (в /public/fonts/),
 * который подгружается и кешируется один раз за сессию.
 */

export type ColType = 'text' | 'number' | 'nmId' | 'rub' | 'pct' | 'date';

export interface ExportColumn {
  key: string;
  label: string;
  type?: ColType;
}

export interface ExportOpts {
  title?: string;
  subtitle?: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
}

function isNumericType(t?: ColType): boolean {
  return t === 'number' || t === 'rub' || t === 'pct' || t === 'nmId';
}

function formatCell(row: Record<string, unknown>, col: ExportColumn): string {
  const v = row[col.key];
  if (v == null || v === '') return '';
  if (col.type === 'rub') {
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽` : String(v);
  }
  if (col.type === 'pct') {
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : String(v);
  }
  if (col.type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('ru-RU') : String(v);
  }
  return String(v);
}

function safeFileName(title: string | undefined): string {
  return (title || 'data').replace(/[^\wа-яА-Я-]+/g, '_').slice(0, 80);
}

// ── Excel ───────────────────────────────────────────────────────────────────

export async function exportToXlsx(opts: ExportOpts): Promise<void> {
  const XLSX = await import('xlsx');
  const { columns, rows, title } = opts;
  const aoa: any[][] = [
    columns.map((c) => c.label),
    ...rows.map((r) => columns.map((c) => {
      const v = r[c.key];
      // Числовые типы кидаем как числа — в Excel работают сортировка/формулы.
      if (isNumericType(c.type) && v != null && v !== '' && Number.isFinite(Number(v))) {
        return Number(v);
      }
      return formatCell(r, c);
    })),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Авто-ширина колонок
  ws['!cols'] = columns.map((c) => {
    const maxLen = Math.max(
      c.label.length,
      ...rows.map((r) => String(r[c.key] ?? '').length),
    );
    return { wch: Math.min(60, Math.max(8, Math.ceil(maxLen * 1.1))) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (title || 'Data').slice(0, 31));
  XLSX.writeFile(wb, `${safeFileName(title)}.xlsx`);
}

// ── PDF ─────────────────────────────────────────────────────────────────────

// Cache ttf → base64 чтобы не скачивать шрифт при каждом экспорте.
let _pdfFontCache: { regular: string; bold: string } | null = null;
let _pdfFontLoading: Promise<{ regular: string; bold: string }> | null = null;

async function loadPdfFontsBase64(): Promise<{ regular: string; bold: string }> {
  if (_pdfFontCache) return _pdfFontCache;
  if (_pdfFontLoading) return _pdfFontLoading;
  _pdfFontLoading = (async () => {
    const toB64 = async (path: string) => {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`font ${path} ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    };
    const [regular, bold] = await Promise.all([
      toB64('/fonts/DejaVuSans.ttf'),
      toB64('/fonts/DejaVuSans-Bold.ttf'),
    ]);
    _pdfFontCache = { regular, bold };
    return _pdfFontCache;
  })();
  try {
    return await _pdfFontLoading;
  } finally {
    _pdfFontLoading = null;
  }
}

async function ensurePdfFontsLoaded(doc: any): Promise<void> {
  const { regular, bold } = await loadPdfFontsBase64();
  doc.addFileToVFS('DejaVuSans.ttf', regular);
  doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', bold);
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
}

export async function exportToPdf(opts: ExportOpts): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const { title, subtitle, columns, rows } = opts;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  try {
    await ensurePdfFontsLoaded(doc);
    doc.setFont('DejaVuSans', 'normal');
  } catch (err) {
    console.warn('PDF font load failed', err);
  }

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const fontSize = 8;
  const rowH = 5.2;

  // Вес колонок: text колонки шире (2), числовые тоньше (1).
  const weights = columns.map((c) => (c.type === 'text' || !c.type ? 2 : 1));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const usableW = pageW - margin * 2;
  const colWidths = weights.map((w) => (usableW * w) / totalW);

  let y = margin;
  // Заголовок
  doc.setFontSize(12);
  doc.setFont('DejaVuSans', 'bold');
  doc.text(title || 'Таблица', margin, y + 4);
  y += 8;
  if (subtitle) {
    doc.setFontSize(9);
    doc.setFont('DejaVuSans', 'normal');
    const sub = doc.splitTextToSize(subtitle, usableW);
    doc.text(sub, margin, y);
    y += sub.length * 4;
  }
  y += 2;

  const drawHeader = () => {
    doc.setFillColor(240, 240, 240);
    doc.rect(margin, y, usableW, rowH, 'F');
    doc.setFontSize(fontSize);
    doc.setFont('DejaVuSans', 'bold');
    let x = margin + 1;
    columns.forEach((c, i) => {
      const label = doc.splitTextToSize(c.label, colWidths[i] - 2)[0] ?? c.label;
      doc.text(label, x, y + 3.6);
      x += colWidths[i];
    });
    y += rowH;
    doc.setFont('DejaVuSans', 'normal');
  };

  drawHeader();

  rows.forEach((r, idx) => {
    if (y + rowH > pageH - margin) {
      doc.addPage();
      y = margin;
      drawHeader();
    }
    if (idx % 2 === 1) {
      doc.setFillColor(248, 248, 248);
      doc.rect(margin, y, usableW, rowH, 'F');
    }
    let x = margin + 1;
    columns.forEach((c, i) => {
      const raw = formatCell(r, c);
      const text = doc.splitTextToSize(raw, colWidths[i] - 2)[0] ?? raw;
      doc.text(text, x, y + 3.6);
      x += colWidths[i];
    });
    y += rowH;
  });

  const footer = `Sigma Seller · ${new Date().toLocaleString('ru-RU')} · строк: ${rows.length}`;
  doc.setFontSize(7);
  doc.setTextColor(120);
  doc.text(footer, margin, pageH - 4);

  doc.save(`${safeFileName(title)}.pdf`);
}
