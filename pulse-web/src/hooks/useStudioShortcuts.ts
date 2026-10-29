/**
 * Hook for keyboard shortcuts in Visual Studio
 */

import { useEffect, useCallback } from 'react';
import { matchShortcut } from '@/lib/studio/shortcuts';

export interface ShortcutHandlers {
  // Tools
  'tool:select'?: () => void;
  'tool:text'?: () => void;
  'tool:rectangle'?: () => void;
  'tool:circle'?: () => void;
  
  // Edit
  undo?: () => void;
  redo?: () => void;
  delete?: () => void;
  copy?: () => void;
  paste?: () => void;
  cut?: () => void;
  duplicate?: () => void;
  selectAll?: () => void;
  
  // Layers
  bringForward?: () => void;
  sendBackward?: () => void;
  bringToFront?: () => void;
  sendToBack?: () => void;
  
  // Zoom
  zoomIn?: () => void;
  zoomOut?: () => void;
  zoomReset?: () => void;
  
  // File
  save?: () => void;
  export?: () => void;
  
  // View
  deselect?: () => void;
}

export function useStudioShortcuts(handlers: ShortcutHandlers, enabled: boolean = true) {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Ignore if typing in input/textarea
    const target = event.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      // Allow Escape in inputs
      if (event.key !== 'Escape') return;
    }

    const action = matchShortcut(event);
    if (!action) return;

    const handler = handlers[action as keyof ShortcutHandlers];
    if (handler) {
      event.preventDefault();
      handler();
    }
  }, [handlers]);

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, enabled]);
}

/**
 * Hook for clipboard operations with Fabric.js
 */
export function useStudioClipboard(
  fabricCanvas: any,
  saveHistory: () => void
) {
  const clipboard = { current: null as any };

  const copy = useCallback(() => {
    const active = fabricCanvas?.getActiveObject();
    if (!active) return;

    active.clone((cloned: any) => {
      clipboard.current = cloned;
    });
  }, [fabricCanvas]);

  const paste = useCallback(async () => {
    if (!clipboard.current || !fabricCanvas) return;

    clipboard.current.clone((cloned: any) => {
      fabricCanvas.discardActiveObject();

      // Offset pasted object
      cloned.set({
        left: (cloned.left || 0) + 20,
        top: (cloned.top || 0) + 20,
        evented: true,
      });

      if (cloned.type === 'activeSelection') {
        // Multiple objects
        cloned.canvas = fabricCanvas;
        cloned.forEachObject((obj: any) => {
          fabricCanvas.add(obj);
        });
        cloned.setCoords();
      } else {
        fabricCanvas.add(cloned);
      }

      // Update clipboard position for next paste
      clipboard.current.top += 20;
      clipboard.current.left += 20;

      fabricCanvas.setActiveObject(cloned);
      fabricCanvas.requestRenderAll();
      saveHistory();
    });
  }, [fabricCanvas, saveHistory]);

  const cut = useCallback(() => {
    copy();
    const active = fabricCanvas?.getActiveObject();
    if (active) {
      fabricCanvas.remove(active);
      fabricCanvas.requestRenderAll();
      saveHistory();
    }
  }, [fabricCanvas, copy, saveHistory]);

  const duplicate = useCallback(() => {
    copy();
    paste();
  }, [copy, paste]);

  const selectAll = useCallback(() => {
    if (!fabricCanvas) return;

    fabricCanvas.discardActiveObject();
    const objects = fabricCanvas.getObjects().filter((obj: any) => !obj.isWorkspace);
    
    if (objects.length === 0) return;

    if (objects.length === 1) {
      fabricCanvas.setActiveObject(objects[0]);
    } else {
      const fabric = (window as any).fabric;
      if (fabric) {
        const selection = new fabric.ActiveSelection(objects, { canvas: fabricCanvas });
        fabricCanvas.setActiveObject(selection);
      }
    }
    fabricCanvas.requestRenderAll();
  }, [fabricCanvas]);

  return { copy, paste, cut, duplicate, selectAll };
}
