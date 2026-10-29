'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppShell } from '@/components/AppShell';
import { apiFetch, csrfHeaders } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { useShopChange } from '@/hooks/useShopChange';
import { cn } from '@/lib/cn';
import {
  FileText,
  Search,
  Trash2,
  Plus,
  X,
  Send,
  Loader2,
  Upload,
  BookOpen,
  Sparkles,
  Bot,
} from 'lucide-react';

// ── Types ────────────────────────────────────────

interface DocMeta {
  documentId: number;
  title: string;
  fileName: string | null;
  fileType: string;
  status: string;
  chunkCount: number;
  createdAt: string;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{ documentId: number; title: string; chunkText: string }>;
}

// ── Page ─────────────────────────────────────────

export default function DocumentsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  // Documents
  const [documents, setDocuments] = useState<DocMeta[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocMeta | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Upload modal
  const [showUpload, setShowUpload] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'text'>('file');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirm
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Load documents — реагирует на смену workspace И shop
  useEffect(() => {
    if (!workspaceId) return;
    loadDocs();
  }, [workspaceId]);
  useShopChange(() => {
    loadDocs();
    // Сбросим выбранный документ при смене магазина (был от другого scope'а)
    setSelectedDoc(null);
    setDocContent(null);
    setMessages([]);
  });

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ documents: DocMeta[] }>('/document-hub/documents');
      setDocuments(res.documents ?? []);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  // Ask question (RAG)
  const handleAsk = useCallback(async () => {
    if (!question.trim() || asking) return;
    const q = question.trim();
    setQuestion('');

    const userMsg: ChatMessage = { id: Date.now(), role: 'user', content: q };
    setMessages((prev) => [...prev, userMsg]);
    setAsking(true);

    try {
      const res = await apiFetch<{ answer: string; sources: any[] }>('/document-hub/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });

      const assistantMsg: ChatMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: res.answer,
        sources: res.sources,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'assistant', content: 'Ошибка при получении ответа.' },
      ]);
    } finally {
      setAsking(false);
    }
  }, [question, asking]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Upload document (file or text)
  const handleUpload = useCallback(async () => {
    setUploadError(null);
    setUploading(true);

    try {
      if (uploadMode === 'file' && uploadFile) {
        // File upload via multipart
        const formData = new FormData();
        formData.append('file', uploadFile);

        // Use raw fetch because apiFetch adds Content-Type: application/json
        const wsId = useWorkspaceStore.getState().workspaceId;
        const res = await fetch(`/api/proxy/document-hub/upload-file?workspaceId=${wsId}`, {
          method: 'POST',
          headers: { ...csrfHeaders() },
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Upload failed' }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
      } else if (uploadMode === 'text' && uploadTitle.trim() && uploadContent.trim()) {
        // Text upload
        await apiFetch('/document-hub/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: uploadTitle.trim(),
            content: uploadContent.trim(),
            isKnowledgeBase: true,
          }),
        });
      } else {
        setUploading(false);
        return;
      }

      setShowUpload(false);
      setUploadFile(null);
      setUploadTitle('');
      setUploadContent('');
      loadDocs();
    } catch (err: any) {
      setUploadError(err.message || 'Ошибка загрузки');
    } finally {
      setUploading(false);
    }
  }, [uploadMode, uploadFile, uploadTitle, uploadContent, loadDocs]);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      setUploadFile(file);
      setUploadMode('file');
    }
  }, []);

  // Delete document
  const handleDelete = useCallback(async (docId: number) => {
    try {
      await apiFetch(`/document-hub/documents/${docId}`, { method: 'DELETE' });
      setDocuments((prev) => prev.filter((d) => d.documentId !== docId));
      if (selectedDoc?.documentId === docId) {
        setSelectedDoc(null);
        setDocContent(null);
      }
    } catch {}
    setDeletingId(null);
  }, [selectedDoc]);

  // Select document → load content
  const handleSelectDoc = useCallback(async (doc: DocMeta) => {
    setSelectedDoc(doc);
    setDocContent(null);
    // Clear chat to show document content
  }, []);

  const totalChunks = documents.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);

  return (
    <AppShell fullHeight title="База знаний">
      <div className="flex h-full bg-white">
        {/* ── Left Panel: Sources ── */}
        <div className="w-72 border-r border-gray-200 flex flex-col bg-gray-50">
          <div className="p-4 border-b border-gray-200">
            <button
              onClick={() => setShowUpload(true)}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600 text-white hover:bg-violet-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="font-medium">Добавить источник</span>
            </button>
          </div>

          {/* Stats */}
          <div className="px-4 py-2 text-xs text-gray-500">
            {documents.length} источников &middot; {totalChunks} фрагментов
          </div>

          {/* Document list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-8 text-sm text-gray-500">
                Нет источников
              </div>
            ) : (
              documents.map((doc) => (
                <div
                  key={doc.documentId}
                  onClick={() => handleSelectDoc(doc)}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors',
                    selectedDoc?.documentId === doc.documentId
                      ? 'bg-violet-100 text-violet-900'
                      : 'hover:bg-gray-100 text-gray-700'
                  )}
                >
                  <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.title}</p>
                    <p className="text-xs text-gray-500">
                      {doc.chunkCount} фр. &middot; {new Date(doc.createdAt).toLocaleDateString('ru-RU')}
                    </p>
                  </div>
                  {deletingId === doc.documentId ? (
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleDelete(doc.documentId)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500 text-white hover:bg-red-600"
                      >
                        Да
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600 hover:bg-gray-300"
                      >
                        Нет
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingId(doc.documentId);
                      }}
                      // На мобиле hover'a нет — кнопка должна быть видна всегда.
                      className="p-1 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-gray-200 text-gray-500 hover:text-red-500 transition-all"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Center Panel: Chat ── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {messages.length === 0 && !selectedDoc ? (
              /* Empty state */
              <div className="flex flex-col items-center justify-center h-full text-center px-8">
                <div className="w-16 h-16 rounded-2xl bg-violet-100 flex items-center justify-center mb-4">
                  <BookOpen className="w-8 h-8 text-violet-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  База знаний
                </h3>
                <p className="text-sm text-gray-500 max-w-md mb-6">
                  Загрузите документы и задавайте вопросы. AI найдёт ответ в ваших источниках.
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {[
                    'Какие требования к фото для WB?',
                    'Условия возврата товара',
                    'Размерная сетка',
                  ].map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setQuestion(prompt);
                        setSelectedDoc(null);
                      }}
                      className="px-4 py-2 rounded-full text-sm bg-gray-100 text-gray-700 hover:bg-violet-100 hover:text-violet-700 transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : selectedDoc && messages.length === 0 ? (
              /* Document preview */
              <div className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <FileText className="w-5 h-5 text-violet-500" />
                  <h3 className="text-lg font-semibold text-gray-900">{selectedDoc.title}</h3>
                </div>
                <div className="text-xs text-gray-500 mb-4">
                  {selectedDoc.chunkCount} фрагментов &middot; {selectedDoc.fileType} &middot; {new Date(selectedDoc.createdAt).toLocaleDateString('ru-RU')}
                </div>
                <p className="text-sm text-gray-500">
                  Задайте вопрос по этому документу в поле ниже.
                </p>
              </div>
            ) : (
              /* Chat history */
              <div className="p-4 space-y-4">
                {messages.map((msg) => (
                  <div key={msg.id}>
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
                        msg.role === 'user' ? 'bg-gray-200' : 'bg-violet-100'
                      )}>
                        {msg.role === 'user' ? (
                          <span className="text-xs font-medium text-gray-600">Вы</span>
                        ) : (
                          <Sparkles className="w-4 h-4 text-violet-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-900 whitespace-pre-wrap">{msg.content}</div>
                        {msg.sources && msg.sources.length > 0 && (
                          <div className="mt-3 space-y-1">
                            <p className="text-xs font-medium text-gray-500">Источники:</p>
                            {msg.sources.map((s, i) => (
                              <div key={i} className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1">
                                [{i + 1}] {s.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {asking && (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Ищу в {documents.length} источниках...
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-gray-200 p-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAsk();
                  }
                }}
                placeholder="Задайте вопрос по документам..."
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm placeholder:text-gray-400 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                disabled={asking}
              />
              <button
                onClick={handleAsk}
                disabled={asking || !question.trim()}
                className={cn(
                  'p-2.5 rounded-lg transition-colors',
                  asking || !question.trim()
                    ? 'bg-gray-100 text-gray-300'
                    : 'bg-violet-600 text-white hover:bg-violet-700'
                )}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1 text-center">
              Enter — отправить
            </p>
          </div>
        </div>

        {/* ── Upload Modal ── */}
        {showUpload && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900">Добавить источник</h3>
                <button onClick={() => { setShowUpload(false); setUploadError(null); setUploadFile(null); }} className="p-1 rounded hover:bg-gray-100">
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              {/* Mode tabs */}
              <div className="flex border-b border-gray-200 px-6">
                <button
                  onClick={() => setUploadMode('file')}
                  className={cn('px-4 py-2.5 text-sm font-medium border-b-2 transition-colors', uploadMode === 'file' ? 'border-violet-500 text-violet-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
                >
                  Файл
                </button>
                <button
                  onClick={() => setUploadMode('text')}
                  className={cn('px-4 py-2.5 text-sm font-medium border-b-2 transition-colors', uploadMode === 'text' ? 'border-violet-500 text-violet-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
                >
                  Текст
                </button>
              </div>

              <div className="p-6 space-y-4">
                {uploadMode === 'file' ? (
                  /* File upload with drag & drop */
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleFileDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors',
                      uploadFile ? 'border-violet-300 bg-violet-50' : 'border-gray-300 hover:border-violet-400 hover:bg-gray-50'
                    )}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setUploadFile(f);
                      }}
                    />
                    {uploadFile ? (
                      <div>
                        <FileText className="w-10 h-10 mx-auto text-violet-500 mb-2" />
                        <p className="text-sm font-medium text-gray-900">{uploadFile.name}</p>
                        <p className="text-xs text-gray-500 mt-1">{(uploadFile.size / 1024).toFixed(0)} KB</p>
                        <button
                          onClick={(e) => { e.stopPropagation(); setUploadFile(null); }}
                          className="text-xs text-red-500 hover:text-red-700 mt-2"
                        >
                          Удалить
                        </button>
                      </div>
                    ) : (
                      <div>
                        <Upload className="w-10 h-10 mx-auto text-gray-300 mb-2" />
                        <p className="text-sm text-gray-600">Перетащите файл или нажмите для выбора</p>
                        <p className="text-xs text-gray-500 mt-1">PDF, DOCX, XLSX, TXT, MD, CSV (до 50 MB)</p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Text input */
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
                      <input
                        type="text"
                        value={uploadTitle}
                        onChange={(e) => setUploadTitle(e.target.value)}
                        placeholder="Например: Инструкция по упаковке"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Содержимое</label>
                      <textarea
                        value={uploadContent}
                        onChange={(e) => setUploadContent(e.target.value)}
                        placeholder="Вставьте текст документа..."
                        rows={10}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                      />
                    </div>
                  </>
                )}

                {uploadError && (
                  <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
                    {uploadError}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
                <button
                  onClick={() => { setShowUpload(false); setUploadError(null); setUploadFile(null); }}
                  className="px-4 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100"
                >
                  Отмена
                </button>
                <button
                  onClick={handleUpload}
                  disabled={uploading || (uploadMode === 'file' ? !uploadFile : (!uploadTitle.trim() || !uploadContent.trim()))}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors',
                    uploading ? 'bg-gray-300' : 'bg-violet-600 hover:bg-violet-700',
                    (uploadMode === 'file' ? !uploadFile : (!uploadTitle.trim() || !uploadContent.trim())) && !uploading ? 'bg-gray-300 cursor-not-allowed' : ''
                  )}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Загрузка...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      Загрузить
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
