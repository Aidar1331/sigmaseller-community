'use client';

import { memo } from 'react';
import { cn } from '@/lib/cn';
import { User, Bot, Copy, Check, FileText, Download } from 'lucide-react';
import { useState } from 'react';
import type { AiMessage, AiAttachment } from '@/store/aiChat';
import { WidgetRenderer } from './widgets/WidgetRenderer';
import { AgentStatusBadge } from './AgentStatusBadge';
import { ActionQueueStatus, extractActionIds } from './ActionQueueStatus';
import { NmIdLink } from '@/components/ui/NmIdLink';
import { CopyTableButton } from '@/components/ui/CopyTableButton';

interface AiChatMessageProps {
  message: AiMessage;
  isStreaming?: boolean;
}

/**
 * Single chat message component.
 * Handles user/assistant messages, markdown rendering, and widgets.
 */
export const AiChatMessage = memo(function AiChatMessage({
  message,
  isStreaming,
}: AiChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  const handleCopy = async () => {
    if (message.content && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(message.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (e) {
        console.error('Clipboard copy failed:', e);
      }
    }
  };

  // Widget message
  if (message.widgetType && message.widgetProps) {
    return (
      <div className="flex gap-3 px-4 py-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-violet-100 flex items-center justify-center">
          <Bot className="w-4 h-4 text-violet-600" />
        </div>
        <div className="flex-1 min-w-0">
          <WidgetRenderer type={message.widgetType} props={message.widgetProps} />
        </div>
      </div>
    );
  }

  // Text message
  return (
    <div
      className={cn(
        'flex gap-3 px-4 py-3 group',
        isUser && 'bg-gray-50'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
          isUser ? 'bg-blue-100' : 'bg-violet-100'
        )}
      >
        {isUser ? (
          <User className="w-4 h-4 text-blue-600" />
        ) : (
          <Bot className="w-4 h-4 text-violet-600" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-sm font-medium text-gray-700">
            {isUser ? 'Вы' : 'Агент'}
          </span>
          <span className="text-xs text-gray-500">
            {new Date(message.createdAt).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {isStreaming && (
            <span className="text-xs text-violet-500 animate-pulse">●</span>
          )}
          {/* Multi-Agent v2 — badge shown when supervisor delegated to a subagent */}
          {isAssistant && message.toolCalls?.map((tc) => {
            if (!tc.name.startsWith('subagent_')) return null;
            const agentName = tc.name.replace(/^subagent_/, '');
            return <AgentStatusBadge key={tc.id} agentName={agentName} runId={tc.id} />;
          })}
        </div>

        {/* Message text */}
        {message.content && (
          <div className="prose prose-sm prose-gray max-w-none">
            <MessageContent content={message.content} />
          </div>
        )}

        {/* Action Queue progress (when assistant referenced `[actionId:N]` from
            durable-queue-mode tool results — backend flag ENABLE_ACTION_QUEUE). */}
        {isAssistant && message.content && (() => {
          const ids = extractActionIds(message.content);
          return ids.length > 0 ? <ActionQueueStatus actionIds={ids} /> : null;
        })()}

        {/* Attachments (PDF/images from tools, e.g. supply slip) */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {message.attachments.map((a, i) => (
              <AttachmentChip key={`${a.url}-${i}`} attachment={a} />
            ))}
          </div>
        )}

        {/* Copy button for assistant messages */}
        {isAssistant && message.content && (
          <button
            onClick={handleCopy}
            className="mt-2 text-gray-500 hover:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Копировать"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
});

/**
 * Render message content with basic markdown support.
 */
function MessageContent({ content }: { content: string }) {
  // Hide context metadata from user messages
  const cleanContent = content.replace(/\n?\n?\[Контекст:[\s\S]*?\]$/, '').trim();
  
  // Simple markdown: bold, code blocks, lists
  const lines = cleanContent.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeContent = '';
  let codeLanguage = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block start/end
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
        codeContent = '';
      } else {
        inCodeBlock = false;
        elements.push(
          <pre
            key={i}
            className="bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto text-sm my-2"
          >
            <code>{codeContent.trim()}</code>
          </pre>
        );
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += line + '\n';
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={i} className="font-semibold text-gray-800 mt-3 mb-1">
          {line.slice(4)}
        </h4>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={i} className="font-semibold text-gray-900 mt-4 mb-2">
          {line.slice(3)}
        </h3>
      );
      continue;
    }

    // Lists
    if (line.match(/^[-•] /)) {
      elements.push(
        <li key={i} className="ml-4 text-gray-700">
          <InlineFormat text={line.slice(2)} />
        </li>
      );
      continue;
    }
    if (line.match(/^\d+\. /)) {
      elements.push(
        <li key={i} className="ml-4 text-gray-700 list-decimal">
          <InlineFormat text={line.replace(/^\d+\. /, '')} />
        </li>
      );
      continue;
    }

    // Markdown table: collect consecutive lines starting with |
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && lines[i + 1].trim().endsWith('|')) {
        i++;
        tableLines.push(lines[i]);
      }
      // Filter out separator rows (|---|---|)
      const dataRows = tableLines.filter(l => !l.match(/^\|[\s-:|]+\|$/));
      if (dataRows.length > 0) {
        const headerCells = dataRows[0].split('|').filter(Boolean).map(c => c.trim());
        const bodyRows = dataRows.slice(1).map(r => r.split('|').filter(Boolean).map(c => c.trim()));
        elements.push(
          <div key={i} className="group relative my-2">
            <div className="absolute right-0 -top-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
              <CopyTableButton headers={headerCells} rows={bodyRows} className="bg-white/90 backdrop-blur-sm border border-gray-200 shadow-sm" />
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    {headerCells.map((cell, ci) => (
                      <th key={ci} className="px-3 py-1.5 text-left font-semibold text-gray-700 bg-gray-50">
                        <InlineFormat text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, ri) => (
                    <tr key={ri} className="border-b border-gray-100">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1.5 text-gray-600">
                          <InlineFormat text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      }
      continue;
    }

    // Horizontal rule
    if (line.trim() === '---' || line.trim() === '***') {
      elements.push(<hr key={i} className="my-3 border-gray-200" />);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      elements.push(
        <blockquote key={i} className="border-l-3 border-violet-300 pl-3 text-gray-600 italic my-1">
          <InlineFormat text={line.slice(2)} />
        </blockquote>
      );
      continue;
    }

    // Regular paragraph
    if (line.trim()) {
      elements.push(
        <p key={i} className="text-gray-700 my-1">
          <InlineFormat text={line} />
        </p>
      );
    } else {
      elements.push(<br key={i} />);
    }
  }

  return <>{elements}</>;
}

/**
 * Inline formatting: **bold**, `code`, *italic*, [text](url), auto-linkify nmId.
 */
function InlineFormat({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} className="font-semibold">
              {linkifyPlain(part.slice(2, -2), `${i}b`)}
            </strong>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**')) {
          return <em key={i}>{linkifyPlain(part.slice(1, -1), `${i}e`)}</em>;
        }
        return <span key={i}>{linkifyPlain(part, `${i}`)}</span>;
      })}
    </>
  );
}

/**
 * Convert a plain text chunk into React nodes, replacing:
 *   1. [text](url)          — markdown link (http/https only)
 *   2. "артикул 123456789"  — auto-link to wildberries.ru
 *   3. "(123456789)"        — bare 7-10 digit nmId in parens
 *   4. bare 9-digit nmId    — standard WB nmId length сейчас (100M-999M).
 *      Не трогаем 10-digit (часто orderId), 8- и меньше (суммы/проценты).
 */
function linkifyPlain(text: string, keyPrefix: string): React.ReactNode[] {
  // Combined regex. Order matters: markdown link первым, потом keyword-prefixed,
  // потом (skobki), потом bare 9-digit. `(?<![\w#№])` / `(?![\w])` — word boundary
  // с учётом unicode и markdown-символов типа `|` в таблицах.
  const pattern =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|((?:артикул[а-я]*|арт\.?|nm[_\s-]?id|sku|товар)[\s:№#]*)(\d{6,12})|\((\d{7,10})\)|(?<![\w#№\-])(\d{9})(?![\w\-])/gi;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const [, mdText, mdUrl, kwPrefix, kwNmId, parenNmId, bareNmId] = match;
    const key = `${keyPrefix}-${idx++}`;

    if (mdUrl) {
      nodes.push(
        <a
          key={key}
          href={mdUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          {mdText}
        </a>
      );
    } else if (kwNmId) {
      nodes.push(kwPrefix);
      nodes.push(<NmIdLink key={key} nmId={kwNmId} />);
    } else if (parenNmId) {
      nodes.push('(');
      nodes.push(<NmIdLink key={key} nmId={parenNmId} />);
      nodes.push(')');
    } else if (bareNmId) {
      nodes.push(<NmIdLink key={key} nmId={bareNmId} />);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length ? nodes : [text];
}

/**
 * Inline-chip для attachments (PDF/image из tools, e.g. лист приёмки).
 */
function AttachmentChip({ attachment }: { attachment: AiAttachment }) {
  const isPdf = attachment.mime === 'application/pdf' || attachment.fileName.endsWith('.pdf');
  const isImage = attachment.mime?.startsWith('image/');
  const sizeKb = attachment.sizeBytes ? Math.round(attachment.sizeBytes / 1024) : null;
  const isUploading = !attachment.url;

  // Image preview — only when we have a real URL.
  if (isImage && !isUploading) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded-lg overflow-hidden border border-gray-200 hover:border-violet-300 transition-colors max-w-xs"
        title={`${attachment.fileName}${sizeKb ? ` (${sizeKb} KB)` : ''}`}
      >
        <img
          src={attachment.url}
          alt={attachment.fileName}
          className="block max-h-64 w-auto object-contain bg-gray-50"
          loading="lazy"
        />
      </a>
    );
  }

  // Generic chip (PDF/DOCX/XLSX, image-while-uploading)
  const wrapperClass = "inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm transition-colors max-w-sm";
  const inner = (
    <>
      <div className="flex-shrink-0 w-8 h-8 rounded bg-violet-100 flex items-center justify-center">
        <FileText className="w-4 h-4 text-violet-600" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">{attachment.fileName}</div>
        <div className="text-xs text-gray-500">
          {isUploading ? 'загружается…' : (isPdf ? 'PDF' : attachment.mime)}
          {sizeKb !== null && ` · ${sizeKb} KB`}
        </div>
      </div>
      {!isUploading && <Download className="w-4 h-4 text-gray-500 flex-shrink-0" />}
    </>
  );
  return isUploading ? (
    <div className={`${wrapperClass} opacity-60`}>{inner}</div>
  ) : (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${wrapperClass} hover:border-violet-300 hover:bg-violet-50`}
      title={`${attachment.fileName}${sizeKb ? ` (${sizeKb} KB)` : ''}`}
    >
      {inner}
    </a>
  );
}
