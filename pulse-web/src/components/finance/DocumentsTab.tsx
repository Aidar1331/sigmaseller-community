'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import {
  FileText, Download, RefreshCw, Calendar,
  FileSpreadsheet, Receipt, Truck, AlertTriangle,
} from 'lucide-react';
import { useWorkspaceStore } from '@/store/workspace';

// WB Documents API возвращает категории как {name, title}, где name — это
// технический код (например `redeem-notification`, `fine`, `act`, `upd`).
type DocumentCategory = {
  name: string;
  title: string;
};

// WB Documents API возвращает документы с полем extensions[] (массив
// доступных форматов: ["zip"], ["pdf"], etc). Для скачивания всегда нужен
// серверу serviceName + extension.
type Document = {
  serviceName: string;
  name: string;
  category: string;
  extensions: string[];
  creationTime: string;
  viewed: boolean;
};

interface DocumentsTabProps {
  workspaceId: number;
}

export function DocumentsTab({ workspaceId }: DocumentsTabProps) {
  const shopId = useWorkspaceStore((s) => s.shopId);
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<DocumentCategory[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
    setDateTo(today.toISOString().slice(0, 10));
    setDateFrom(thirtyDaysAgo.toISOString().slice(0, 10));
  }, []);

  const shopQs = shopId ? `&shopId=${shopId}` : '';

  const loadCategories = useCallback(async () => {
    try {
      const res = await apiFetch<{ ok: boolean; data?: { categories?: DocumentCategory[] } }>(
        `/analytics/${workspaceId}/documents/categories?_=1${shopQs}`,
      );
      setCategories(res.data?.categories ?? []);
    } catch (e: any) {
      console.error('Failed to load categories:', e);
    }
  }, [workspaceId, shopQs]);

  const loadDocuments = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('beginTime', dateFrom);
      params.set('endTime', dateTo);
      if (selectedCategory) params.set('category', selectedCategory);
      if (shopId) params.set('shopId', String(shopId));

      const res = await apiFetch<{ ok: boolean; data?: { documents?: Document[] } }>(
        `/analytics/${workspaceId}/documents?${params}`,
      );
      setDocuments(res.data?.documents ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить документы');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, shopId, dateFrom, dateTo, selectedCategory]);

  const downloadOne = async (doc: Document) => {
    setDownloading(doc.serviceName);
    setError(null);
    try {
      const extension = doc.extensions?.[0] ?? 'pdf';
      const params = new URLSearchParams();
      params.set('serviceName', doc.serviceName);
      params.set('extension', extension);
      if (shopId) params.set('shopId', String(shopId));

      const res = await apiFetch<{ ok: boolean; data?: { fileName: string; extension: string; document: string } }>(
        `/analytics/${workspaceId}/documents/download?${params}`,
      );
      const data = res.data;
      if (!data?.document) {
        throw new Error('Документ не получен от WB');
      }

      const byteCharacters = atob(data.document);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const mimeType =
        data.extension === 'pdf' ? 'application/pdf' :
        data.extension === 'zip' ? 'application/zip' :
        data.extension === 'xml' ? 'application/xml' :
        'application/octet-stream';
      const blob = new Blob([byteArray], { type: mimeType });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.fileName || `${doc.name || doc.serviceName}.${data.extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось скачать документ');
    } finally {
      setDownloading(null);
    }
  };

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    if (dateFrom && dateTo) loadDocuments();
  }, [loadDocuments, dateFrom, dateTo]);

  const getCategoryTitle = (categoryName: string): string => {
    const cat = categories.find((c) => c.name === categoryName);
    return cat?.title || categoryName;
  };

  const getDocumentIcon = (categoryName: string) => {
    if (categoryName.includes('fine')) return AlertTriangle;
    if (categoryName.includes('act')) return Receipt;
    if (categoryName.includes('upd') || categoryName.includes('invoice')) return FileSpreadsheet;
    if (categoryName.includes('redeem') || categoryName.includes('delivery')) return Truck;
    return FileText;
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-gray-500" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm"
            />
            <span className="text-gray-500">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm"
            />
          </div>

          {categories.length > 0 && (
            <select
              className="h-9 rounded-lg border border-gray-300 bg-white px-3 text-sm"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="">Все категории</option>
              {categories.map((cat) => (
                <option key={cat.name} value={cat.name}>
                  {cat.title}
                </option>
              ))}
            </select>
          )}

          <Button variant="neutral" size="sm" onClick={loadDocuments} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            Обновить
          </Button>
        </div>
      </Card>

      {error && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-600">{error}</p>
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Загрузка документов…</div>
        ) : documents.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p>Нет документов за выбранный период</p>
            <p className="text-xs mt-2">WB присылает акты, УПД, отчёты о реализации и уведомления о штрафах — обычно с задержкой 1-3 дня.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {documents.map((doc) => {
              const Icon = getDocumentIcon(doc.category);
              const dt = doc.creationTime ? new Date(doc.creationTime) : null;
              return (
                <div
                  key={doc.serviceName}
                  className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                      <Icon className="h-5 w-5 text-indigo-600" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {doc.name || doc.serviceName}
                      </div>
                      <div className="text-sm text-gray-500 flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary">{getCategoryTitle(doc.category)}</Badge>
                        {dt && (
                          <span>{dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                        )}
                        {!doc.viewed && <span className="text-indigo-600 font-medium">· новый</span>}
                      </div>
                    </div>
                  </div>

                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => downloadOne(doc)}
                    loading={downloading === doc.serviceName}
                    title={`Скачать .${doc.extensions?.[0] ?? 'pdf'}`}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {documents.length > 0 && (
        <div className="text-sm text-gray-500 text-center">
          Найдено {documents.length} документов
        </div>
      )}
    </div>
  );
}
