'use client';

import { useState } from 'react';
import { X, Plus, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';

type MinusPhrasesProps = {
  phrases: string[];
  onSave: (phrases: string[]) => Promise<void>;
  loading?: boolean;
};

export function MinusPhrases({ phrases, onSave, loading }: MinusPhrasesProps) {
  const [localPhrases, setLocalPhrases] = useState<string[]>(phrases);
  const [newPhrase, setNewPhrase] = useState('');
  const [saving, setSaving] = useState(false);

  // Check if there are unsaved changes
  const hasChanges =
    localPhrases.length !== phrases.length ||
    localPhrases.some((p, i) => p !== phrases[i]);

  const handleAdd = () => {
    const trimmed = newPhrase.trim().toLowerCase();
    if (trimmed && !localPhrases.includes(trimmed)) {
      setLocalPhrases([...localPhrases, trimmed]);
      setNewPhrase('');
    }
  };

  const handleRemove = (phrase: string) => {
    setLocalPhrases(localPhrases.filter((p) => p !== phrase));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(localPhrases);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setLocalPhrases(phrases);
    setNewPhrase('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Add new phrase */}
      <div className="flex items-center gap-2">
        <Input
          value={newPhrase}
          onChange={(e) => setNewPhrase(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Добавить минус-фразу..."
          className="flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!newPhrase.trim()}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Phrases list */}
      {localPhrases.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          Нет минус-фраз. Добавьте фразы, по которым не хотите показываться.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {localPhrases.map((phrase) => (
            <Badge
              key={phrase}
              variant="secondary"
              className="flex items-center gap-1 py-1.5 px-3"
            >
              <span>{phrase}</span>
              <button
                onClick={() => handleRemove(phrase)}
                className="ml-1 hover:text-red-500 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Actions */}
      {hasChanges && (
        <div className="flex items-center justify-end gap-2 pt-4 border-t border-gray-200 dark:border-gray-700">
          <Button size="sm" variant="outline" onClick={handleReset}>
            Отменить
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Сохранить ({localPhrases.length})
          </Button>
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-gray-500">
        Минус-фразы исключают показы по запросам, содержащим эти слова.
        Используйте для отсечения нерелевантного трафика.
      </div>
    </div>
  );
}
