/**
 * Keyboard shortcuts for Visual Studio editor
 */

export interface ShortcutAction {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: string;
  description: string;
}

export const SHORTCUTS: ShortcutAction[] = [
  // Tools
  { key: 'v', action: 'tool:select', description: 'Инструмент выбора' },
  { key: 't', action: 'tool:text', description: 'Добавить текст' },
  { key: 'r', action: 'tool:rectangle', description: 'Добавить прямоугольник' },
  { key: 'c', action: 'tool:circle', description: 'Добавить круг' },
  
  // Edit
  { key: 'z', ctrl: true, action: 'undo', description: 'Отменить' },
  { key: 'z', ctrl: true, shift: true, action: 'redo', description: 'Повторить' },
  { key: 'y', ctrl: true, action: 'redo', description: 'Повторить' },
  { key: 'Delete', action: 'delete', description: 'Удалить выбранное' },
  { key: 'Backspace', action: 'delete', description: 'Удалить выбранное' },
  
  // Clipboard
  { key: 'c', ctrl: true, action: 'copy', description: 'Копировать' },
  { key: 'v', ctrl: true, action: 'paste', description: 'Вставить' },
  { key: 'x', ctrl: true, action: 'cut', description: 'Вырезать' },
  { key: 'd', ctrl: true, action: 'duplicate', description: 'Дублировать' },
  { key: 'a', ctrl: true, action: 'selectAll', description: 'Выбрать всё' },
  
  // Layers
  { key: ']', ctrl: true, action: 'bringForward', description: 'На слой выше' },
  { key: '[', ctrl: true, action: 'sendBackward', description: 'На слой ниже' },
  { key: ']', ctrl: true, shift: true, action: 'bringToFront', description: 'На передний план' },
  { key: '[', ctrl: true, shift: true, action: 'sendToBack', description: 'На задний план' },
  
  // Zoom
  { key: '+', ctrl: true, action: 'zoomIn', description: 'Приблизить' },
  { key: '=', ctrl: true, action: 'zoomIn', description: 'Приблизить' },
  { key: '-', ctrl: true, action: 'zoomOut', description: 'Отдалить' },
  { key: '0', ctrl: true, action: 'zoomReset', description: 'Сбросить масштаб' },
  
  // File
  { key: 's', ctrl: true, action: 'save', description: 'Сохранить' },
  { key: 'e', ctrl: true, action: 'export', description: 'Экспорт' },
  
  // View
  { key: 'Escape', action: 'deselect', description: 'Снять выделение' },
];

/**
 * Match keyboard event to shortcut action
 */
export function matchShortcut(event: KeyboardEvent): string | null {
  const key = event.key;
  const ctrl = event.ctrlKey || event.metaKey;
  const shift = event.shiftKey;
  const alt = event.altKey;

  for (const shortcut of SHORTCUTS) {
    const keyMatch = shortcut.key.toLowerCase() === key.toLowerCase();
    const ctrlMatch = !!shortcut.ctrl === ctrl;
    const shiftMatch = !!shortcut.shift === shift;
    const altMatch = !!shortcut.alt === alt;

    if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
      return shortcut.action;
    }
  }

  return null;
}

/**
 * Format shortcut for display
 */
export function formatShortcut(shortcut: ShortcutAction): string {
  const parts: string[] = [];
  
  if (shortcut.ctrl) parts.push('Ctrl');
  if (shortcut.shift) parts.push('Shift');
  if (shortcut.alt) parts.push('Alt');
  
  // Format special keys
  let key = shortcut.key;
  if (key === 'Delete') key = 'Del';
  if (key === 'Escape') key = 'Esc';
  if (key === 'Backspace') key = '⌫';
  
  parts.push(key.toUpperCase());
  
  return parts.join('+');
}

/**
 * Group shortcuts by category
 */
export function getShortcutsByCategory(): Record<string, ShortcutAction[]> {
  return {
    'Инструменты': SHORTCUTS.filter((s) => s.action.startsWith('tool:')),
    'Редактирование': SHORTCUTS.filter((s) => 
      ['undo', 'redo', 'delete', 'copy', 'paste', 'cut', 'duplicate', 'selectAll'].includes(s.action)
    ),
    'Слои': SHORTCUTS.filter((s) => 
      ['bringForward', 'sendBackward', 'bringToFront', 'sendToBack'].includes(s.action)
    ),
    'Масштаб': SHORTCUTS.filter((s) => s.action.startsWith('zoom')),
    'Файл': SHORTCUTS.filter((s) => ['save', 'export'].includes(s.action)),
    'Другое': SHORTCUTS.filter((s) => ['deselect'].includes(s.action)),
  };
}
