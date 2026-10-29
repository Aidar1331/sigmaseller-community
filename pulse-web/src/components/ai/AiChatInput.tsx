'use client';

import { useState, useRef, useCallback } from 'react';
import { Send, Square, Loader2, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

const ACCEPT_TYPES = 'image/jpeg,image/png,image/gif,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,text/csv,.txt,.md,.csv';
const MAX_FILES = 5;
const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const MAX_BYTES_IMAGE = 5 * 1024 * 1024;
const MAX_BYTES_TOTAL = 30 * 1024 * 1024;

interface AiChatInputProps {
  onSend: (message: string, files?: File[]) => void;
  onCancel?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
}

export function AiChatInput({
  onSend,
  onCancel,
  disabled,
  isStreaming,
  placeholder = 'Задайте вопрос агенту...',
}: AiChatInputProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || disabled) return;

    onSend(trimmed, files.length > 0 ? files : undefined);
    setText('');
    setFiles([]);
    setError(null);

    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [text, files, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Clipboard paste — extract images from the system clipboard (Ctrl+V on
  // a screenshot, or copying an image from any web page). Text paste is
  // left to the browser's default behaviour.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && (file.type.startsWith('image/') || file.type === 'application/pdf')) {
          // Screenshots from clipboard come as `image/png` with an empty
          // `name` — synthesize one so the chip + backend-multipart can show
          // and route it correctly.
          const name = file.name && file.name !== 'image.png'
            ? file.name
            : `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          pastedFiles.push(new File([file], name, { type: file.type }));
        }
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      validateAndAdd(pastedFiles);
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  };

  const validateAndAdd = (newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    const accepted: File[] = [...files];
    let runningTotal = totalBytes;

    for (const f of arr) {
      if (accepted.length >= MAX_FILES) {
        setError(`Максимум ${MAX_FILES} файлов за сообщение.`);
        break;
      }
      const isImage = f.type.startsWith('image/');
      const sizeLimit = isImage ? MAX_BYTES_IMAGE : MAX_BYTES_PER_FILE;
      if (f.size > sizeLimit) {
        setError(`«${f.name}» больше ${(sizeLimit / 1024 / 1024).toFixed(0)} МБ.`);
        continue;
      }
      if (runningTotal + f.size > MAX_BYTES_TOTAL) {
        setError(`Суммарный размер превышает ${(MAX_BYTES_TOTAL / 1024 / 1024).toFixed(0)} МБ.`);
        break;
      }
      accepted.push(f);
      runningTotal += f.size;
    }
    setFiles(accepted);
    if (arr.length > 0 && accepted.length === files.length) {
      // nothing actually added — error already set
    } else {
      setError(null);
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) validateAndAdd(e.target.files);
    // Allow re-picking the same file
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) validateAndAdd(e.dataTransfer.files);
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setError(null);
  };

  const canSend = (text.trim().length > 0 || files.length > 0) && !disabled;

  return (
    <div
      className={cn(
        'border-t border-gray-200 bg-white p-4 transition-colors safe-bottom',
        dragOver && 'bg-violet-50 ring-2 ring-violet-300 ring-inset',
      )}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {files.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {files.map((f, idx) => (
            <FileChip key={`${f.name}-${idx}`} file={f} onRemove={() => removeFile(idx)} />
          ))}
        </div>
      )}

      {error && (
        <div className="mb-2 text-xs text-red-600 px-1">{error}</div>
      )}

      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isStreaming || files.length >= MAX_FILES}
          className={cn(
            'flex-shrink-0 p-3 rounded-xl text-gray-500',
            'hover:text-violet-600 hover:bg-violet-50',
            'disabled:opacity-30 disabled:cursor-not-allowed',
            'transition-colors',
          )}
          title="Прикрепить файл (картинки / PDF / DOCX / XLSX / TXT)"
        >
          <Paperclip className="w-5 h-5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_TYPES}
          multiple
          onChange={handleFilePick}
          className="hidden"
        />

        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={files.length > 0 ? 'Опишите что сделать с файлами (необязательно)…' : placeholder}
            disabled={disabled || isStreaming}
            rows={1}
            className={cn(
              'w-full resize-none rounded-xl border border-gray-200 bg-gray-50',
              'px-4 py-3 pr-12',
              'text-sm text-gray-900 placeholder:text-gray-400',
              'focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors'
            )}
            style={{ maxHeight: '200px' }}
          />
        </div>

        {isStreaming ? (
          <button
            onClick={onCancel}
            className={cn(
              'flex-shrink-0 p-3 rounded-xl',
              'bg-red-500 text-white hover:bg-red-600',
              'transition-colors'
            )}
            title="Остановить"
          >
            <Square className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!canSend}
            className={cn(
              'flex-shrink-0 p-3 rounded-xl',
              'bg-violet-600 text-white hover:bg-violet-700',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors'
            )}
            title="Отправить"
          >
            {disabled ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        )}
      </div>

      <p className="mt-2 text-xs text-gray-500 text-center">
        Enter — отправить, Shift+Enter — новая строка{files.length > 0 && ` · ${files.length}/${MAX_FILES} файлов · ${(totalBytes / 1024 / 1024).toFixed(1)} МБ`}
      </p>
    </div>
  );
}

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith('image/');
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  // Lazy thumbnail for images
  if (isImage && !thumbUrl) {
    const url = URL.createObjectURL(file);
    setThumbUrl(url);
  }

  return (
    <div className="relative group flex items-center gap-2 px-2 py-1.5 rounded-lg border border-gray-200 bg-gray-50 max-w-xs">
      {isImage && thumbUrl ? (
        <img src={thumbUrl} alt={file.name} className="w-10 h-10 object-cover rounded" />
      ) : (
        <div className="w-10 h-10 flex items-center justify-center rounded bg-violet-100 text-violet-600">
          {isImage ? <ImageIcon className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-gray-900 truncate" title={file.name}>{file.name}</div>
        <div className="text-[10px] text-gray-500">{(file.size / 1024).toFixed(0)} КБ</div>
      </div>
      <button
        onClick={onRemove}
        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-gray-200 text-gray-600 hover:bg-red-500 hover:text-white transition-colors"
        title="Удалить"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
