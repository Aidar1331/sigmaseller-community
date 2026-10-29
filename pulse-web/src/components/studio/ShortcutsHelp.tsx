'use client';

import { useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { getShortcutsByCategory, formatShortcut, type ShortcutAction } from '@/lib/studio/shortcuts';

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  if (!open) return null;

  const categories = getShortcutsByCategory();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Keyboard className="w-5 h-5" />
            <h2 className="text-lg font-bold">Горячие клавиши</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-auto max-h-[calc(80vh-80px)]">
          <div className="grid md:grid-cols-2 gap-6">
            {Object.entries(categories).map(([category, shortcuts]) => (
              <div key={category}>
                <h3 className="font-medium text-sm text-muted-foreground mb-2">
                  {category}
                </h3>
                <div className="space-y-1">
                  {shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.action}
                      className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50"
                    >
                      <span className="text-sm">{shortcut.description}</span>
                      <kbd className="px-2 py-0.5 bg-muted rounded text-xs font-mono">
                        {formatShortcut(shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t text-center text-sm text-muted-foreground">
          Нажмите <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">?</kbd> чтобы показать/скрыть
        </div>
      </div>
    </div>
  );
}

/**
 * Button to open shortcuts help
 */
export function ShortcutsHelpButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground"
        title="Горячие клавиши (?)"
      >
        <Keyboard className="w-4 h-4" />
      </button>
      <ShortcutsHelp open={open} onClose={() => setOpen(false)} />
    </>
  );
}
