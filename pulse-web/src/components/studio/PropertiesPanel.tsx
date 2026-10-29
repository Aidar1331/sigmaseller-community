'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  ChevronUp,
  ChevronDown,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Italic,
  Underline,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Trash2,
  Copy,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
} from 'lucide-react';

interface PropertiesPanelProps {
  selectedObject: any;
  fabricCanvas: any;
  onUpdate: () => void;
}

export function PropertiesPanel({ selectedObject, fabricCanvas, onUpdate }: PropertiesPanelProps) {
  const [localProps, setLocalProps] = useState<any>({});

  // Sync local state with selected object
  useEffect(() => {
    if (!selectedObject) {
      setLocalProps({});
      return;
    }

    setLocalProps({
      left: Math.round(selectedObject.left || 0),
      top: Math.round(selectedObject.top || 0),
      width: Math.round((selectedObject.width || 0) * (selectedObject.scaleX || 1)),
      height: Math.round((selectedObject.height || 0) * (selectedObject.scaleY || 1)),
      angle: Math.round(selectedObject.angle || 0),
      opacity: Math.round((selectedObject.opacity || 1) * 100),
      fill: selectedObject.fill || '#000000',
      stroke: selectedObject.stroke || '',
      strokeWidth: selectedObject.strokeWidth || 0,
      // Text properties
      fontSize: selectedObject.fontSize || 24,
      fontWeight: selectedObject.fontWeight || 'normal',
      fontStyle: selectedObject.fontStyle || 'normal',
      textAlign: selectedObject.textAlign || 'left',
      underline: selectedObject.underline || false,
    });
  }, [selectedObject]);

  const updateProperty = useCallback((prop: string, value: any) => {
    if (!selectedObject || !fabricCanvas) return;

    if (prop === 'width') {
      selectedObject.set('scaleX', value / selectedObject.width);
    } else if (prop === 'height') {
      selectedObject.set('scaleY', value / selectedObject.height);
    } else if (prop === 'opacity') {
      selectedObject.set('opacity', value / 100);
    } else {
      selectedObject.set(prop, value);
    }

    selectedObject.setCoords();
    fabricCanvas.renderAll();
    onUpdate();
    
    setLocalProps((prev: any) => ({ ...prev, [prop]: value }));
  }, [selectedObject, fabricCanvas, onUpdate]);

  const handleDelete = () => {
    if (!selectedObject || !fabricCanvas) return;
    fabricCanvas.remove(selectedObject);
    fabricCanvas.renderAll();
    onUpdate();
  };

  const handleDuplicate = () => {
    if (!selectedObject || !fabricCanvas) return;
    selectedObject.clone((cloned: any) => {
      cloned.set({
        left: (cloned.left || 0) + 20,
        top: (cloned.top || 0) + 20,
      });
      fabricCanvas.add(cloned);
      fabricCanvas.setActiveObject(cloned);
      fabricCanvas.renderAll();
      onUpdate();
    });
  };

  const handleFlip = (direction: 'x' | 'y') => {
    if (!selectedObject || !fabricCanvas) return;
    if (direction === 'x') {
      selectedObject.set('flipX', !selectedObject.flipX);
    } else {
      selectedObject.set('flipY', !selectedObject.flipY);
    }
    fabricCanvas.renderAll();
    onUpdate();
  };

  const handleRotate = (degrees: number) => {
    if (!selectedObject || !fabricCanvas) return;
    selectedObject.rotate((selectedObject.angle || 0) + degrees);
    fabricCanvas.renderAll();
    onUpdate();
  };

  if (!selectedObject) {
    return (
      <div className="p-4 text-center text-muted-foreground text-sm">
        Выберите объект для редактирования
      </div>
    );
  }

  const isText = selectedObject.type === 'i-text' || selectedObject.type === 'text';
  const isImage = selectedObject.type === 'image';

  return (
    <div className="p-4 space-y-4 text-sm">
      {/* Quick Actions */}
      <div className="flex gap-1 pb-3 border-b">
        <button
          onClick={handleDuplicate}
          className="p-2 hover:bg-muted rounded"
          title="Дублировать"
        >
          <Copy className="w-4 h-4" />
        </button>
        <button
          onClick={() => handleRotate(90)}
          className="p-2 hover:bg-muted rounded"
          title="Повернуть на 90°"
        >
          <RotateCw className="w-4 h-4" />
        </button>
        <button
          onClick={() => handleFlip('x')}
          className="p-2 hover:bg-muted rounded"
          title="Отразить по горизонтали"
        >
          <FlipHorizontal className="w-4 h-4" />
        </button>
        <button
          onClick={() => handleFlip('y')}
          className="p-2 hover:bg-muted rounded"
          title="Отразить по вертикали"
        >
          <FlipVertical className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button
          onClick={handleDelete}
          className="p-2 hover:bg-muted rounded text-destructive"
          title="Удалить"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Position */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-2 block">Позиция</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground">X</label>
            <input
              type="number"
              value={localProps.left || 0}
              onChange={(e) => updateProperty('left', Number(e.target.value))}
              className="w-full px-2 py-1 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Y</label>
            <input
              type="number"
              value={localProps.top || 0}
              onChange={(e) => updateProperty('top', Number(e.target.value))}
              className="w-full px-2 py-1 border rounded text-sm"
            />
          </div>
        </div>
      </div>

      {/* Size */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-2 block">Размер</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground">Ширина</label>
            <input
              type="number"
              value={localProps.width || 0}
              onChange={(e) => updateProperty('width', Number(e.target.value))}
              className="w-full px-2 py-1 border rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Высота</label>
            <input
              type="number"
              value={localProps.height || 0}
              onChange={(e) => updateProperty('height', Number(e.target.value))}
              className="w-full px-2 py-1 border rounded text-sm"
            />
          </div>
        </div>
      </div>

      {/* Rotation & Opacity */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Угол</label>
          <input
            type="number"
            value={localProps.angle || 0}
            onChange={(e) => updateProperty('angle', Number(e.target.value))}
            className="w-full px-2 py-1 border rounded text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Прозрачность</label>
          <input
            type="number"
            min={0}
            max={100}
            value={localProps.opacity || 100}
            onChange={(e) => updateProperty('opacity', Number(e.target.value))}
            className="w-full px-2 py-1 border rounded text-sm"
          />
        </div>
      </div>

      {/* Colors (for shapes) */}
      {!isImage && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Цвет</label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Заливка</label>
              <div className="flex gap-1">
                <input
                  type="color"
                  value={localProps.fill || '#000000'}
                  onChange={(e) => updateProperty('fill', e.target.value)}
                  className="w-8 h-8 rounded border cursor-pointer"
                />
                <input
                  type="text"
                  value={localProps.fill || ''}
                  onChange={(e) => updateProperty('fill', e.target.value)}
                  className="flex-1 px-2 py-1 border rounded text-xs font-mono"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Обводка</label>
              <div className="flex gap-1">
                <input
                  type="color"
                  value={localProps.stroke || '#000000'}
                  onChange={(e) => updateProperty('stroke', e.target.value)}
                  className="w-8 h-8 rounded border cursor-pointer"
                />
                <input
                  type="number"
                  value={localProps.strokeWidth || 0}
                  onChange={(e) => updateProperty('strokeWidth', Number(e.target.value))}
                  className="w-12 px-2 py-1 border rounded text-xs"
                  placeholder="px"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Text properties */}
      {isText && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-2 block">Текст</label>
          <div className="space-y-2">
            <div className="flex gap-1">
              <button
                onClick={() => updateProperty('fontWeight', localProps.fontWeight === 'bold' ? 'normal' : 'bold')}
                className={`p-2 rounded ${localProps.fontWeight === 'bold' ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <Bold className="w-4 h-4" />
              </button>
              <button
                onClick={() => updateProperty('fontStyle', localProps.fontStyle === 'italic' ? 'normal' : 'italic')}
                className={`p-2 rounded ${localProps.fontStyle === 'italic' ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <Italic className="w-4 h-4" />
              </button>
              <button
                onClick={() => updateProperty('underline', !localProps.underline)}
                className={`p-2 rounded ${localProps.underline ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <Underline className="w-4 h-4" />
              </button>
              <div className="w-px bg-border mx-1" />
              <button
                onClick={() => updateProperty('textAlign', 'left')}
                className={`p-2 rounded ${localProps.textAlign === 'left' ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <AlignLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => updateProperty('textAlign', 'center')}
                className={`p-2 rounded ${localProps.textAlign === 'center' ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <AlignCenter className="w-4 h-4" />
              </button>
              <button
                onClick={() => updateProperty('textAlign', 'right')}
                className={`p-2 rounded ${localProps.textAlign === 'right' ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <AlignRight className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Размер шрифта</label>
              <input
                type="number"
                value={localProps.fontSize || 24}
                onChange={(e) => updateProperty('fontSize', Number(e.target.value))}
                className="w-full px-2 py-1 border rounded text-sm"
              />
            </div>
          </div>
        </div>
      )}

      {/* Layer controls */}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-2 block">Слой</label>
        <div className="flex gap-1">
          <button
            onClick={() => {
              fabricCanvas?.bringObjectForward(selectedObject);
              fabricCanvas?.renderAll();
            }}
            className="flex-1 p-2 border rounded hover:bg-muted flex items-center justify-center gap-1"
          >
            <ChevronUp className="w-4 h-4" />
            <span className="text-xs">Выше</span>
          </button>
          <button
            onClick={() => {
              fabricCanvas?.sendObjectBackwards(selectedObject);
              fabricCanvas?.renderAll();
            }}
            className="flex-1 p-2 border rounded hover:bg-muted flex items-center justify-center gap-1"
          >
            <ChevronDown className="w-4 h-4" />
            <span className="text-xs">Ниже</span>
          </button>
        </div>
      </div>
    </div>
  );
}
