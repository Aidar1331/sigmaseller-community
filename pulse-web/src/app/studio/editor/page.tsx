'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  MousePointer2,
  Type,
  Square,
  Circle,
  Minus,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Download,
  Save,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Trash2,
  Wand2,
  Sparkles,
  Loader2,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { useWorkspaceStore } from '@/store/workspace';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { AIPanel, ExportModal, PropertiesPanel, SaveStatus, ShortcutsHelpButton } from '@/components/studio';
import { useStudioShortcuts, useStudioClipboard } from '@/hooks/useStudioShortcuts';
import { useAutoSave, formatLastSaved } from '@/hooks/useAutoSave';

// Размеры для разных маркетплейсов
const SIZE_PRESETS = [
  { id: 'wb', label: 'WB Карточка', width: 900, height: 1200 },
  { id: 'ozon', label: 'Ozon Карточка', width: 1200, height: 1600 },
  { id: 'square', label: 'Квадрат', width: 1200, height: 1200 },
  { id: 'wide', label: '16:9', width: 1920, height: 1080 },
];

type Tool = 'select' | 'text' | 'rectangle' | 'circle' | 'line';

function EditorContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const queryClient = useQueryClient();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<any>(null);
  const workspaceRef = useRef<any>(null);

  const [isReady, setIsReady] = useState(false);
  const [currentTool, setCurrentTool] = useState<Tool>('select');
  const [selectedObject, setSelectedObject] = useState<any>(null);
  const [zoom, setZoom] = useState(1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [projectName, setProjectName] = useState('Новый проект');
  const [isSaving, setIsSaving] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);

  // Params from URL
  const projectId = searchParams.get('projectId');
  const initialPhoto = searchParams.get('photo');
  const preset = searchParams.get('preset') || 'wb';
  const mode = searchParams.get('mode');

  const sizePreset = SIZE_PRESETS.find((p) => p.id === preset) || SIZE_PRESETS[0];

  // Load existing project
  const { data: projectData } = useQuery({
    queryKey: ['studio-project', projectId],
    queryFn: () => apiFetch(`/studio/projects/${projectId}?workspaceId=${workspaceId}`),
    enabled: !!projectId && !!workspaceId,
  });

  // Set project ID from URL
  useEffect(() => {
    if (projectId) {
      setCurrentProjectId(Number(projectId));
    }
  }, [projectId]);

  // Auto-save hook
  const autoSave = useAutoSave({
    projectId: currentProjectId,
    projectName,
    getCanvasData: () => fabricRef.current?.toJSON(['isWorkspace']) || null,
    getThumbnail: () => {
      if (!fabricRef.current || !workspaceRef.current) return null;
      const ws = workspaceRef.current;
      return fabricRef.current.toDataURL({
        format: 'jpeg',
        quality: 0.5,
        left: ws.left - ws.width / 2,
        top: ws.top - ws.height / 2,
        width: ws.width,
        height: ws.height,
        multiplier: 0.2,
      });
    },
    enabled: isReady,
    onSaved: (newProjectId) => {
      setCurrentProjectId(newProjectId);
      router.replace(`/studio/editor?projectId=${newProjectId}`, { scroll: false });
    },
  });

  // Clipboard operations
  const clipboard = useStudioClipboard(fabricRef.current, () => autoSave.markDirty());

  // Keyboard shortcuts
  useStudioShortcuts({
    'tool:select': () => setCurrentTool('select'),
    'tool:text': () => { addText(); setCurrentTool('select'); },
    'tool:rectangle': () => { addShape('rectangle'); setCurrentTool('select'); },
    'tool:circle': () => { addShape('circle'); setCurrentTool('select'); },
    undo: () => undo(),
    redo: () => redo(),
    delete: () => deleteSelected(),
    copy: clipboard.copy,
    paste: clipboard.paste,
    cut: clipboard.cut,
    duplicate: clipboard.duplicate,
    selectAll: clipboard.selectAll,
    bringForward: () => fabricRef.current?.bringObjectForward(selectedObject),
    sendBackward: () => fabricRef.current?.sendObjectBackwards(selectedObject),
    bringToFront: () => fabricRef.current?.bringObjectToFront(selectedObject),
    sendToBack: () => fabricRef.current?.sendObjectToBack(selectedObject),
    zoomIn: () => handleZoom(0.1),
    zoomOut: () => handleZoom(-0.1),
    zoomReset: () => { setZoom(1); fabricRef.current?.setZoom(1); },
    save: () => autoSave.forceSave(),
    export: () => setShowExportModal(true),
    deselect: () => fabricRef.current?.discardActiveObject()?.renderAll(),
  }, isReady);

  // Initialize Fabric.js
  useEffect(() => {
    if (!canvasRef.current || fabricRef.current) return;

    // Guard against React StrictMode double-invoke
    let cancelled = false;

    const initFabric = async () => {
      try {
        const fabric = await import('fabric');
        if (cancelled || fabricRef.current) return;
        console.log('[Studio] Fabric loaded:', !!fabric);

        const canvas = new fabric.Canvas(canvasRef.current!, {
        width: window.innerWidth - 380,
        height: window.innerHeight - 150,
        backgroundColor: '#e5e5e5',
        preserveObjectStacking: true,
        selection: true,
      });

      fabricRef.current = canvas;

      // Create workspace (white area)
      const workspace = new fabric.Rect({
        width: sizePreset.width,
        height: sizePreset.height,
        fill: '#ffffff',
        selectable: false,
        hasControls: false,
        hoverCursor: 'default',
        evented: false,
        shadow: new fabric.Shadow({
          color: 'rgba(0,0,0,0.15)',
          blur: 20,
          offsetX: 0,
          offsetY: 4,
        }),
      });
      (workspace as any).isWorkspace = true;

      canvas.add(workspace);
      workspaceRef.current = workspace;

      // Center workspace
      centerWorkspace(canvas, workspace);

      // Events
      canvas.on('selection:created', (e: any) => setSelectedObject(e.selected?.[0]));
      canvas.on('selection:updated', (e: any) => setSelectedObject(e.selected?.[0]));
      canvas.on('selection:cleared', () => setSelectedObject(null));
      canvas.on('object:modified', () => saveToHistory());

      // Window resize
      const handleResize = () => {
        canvas.setDimensions({
          width: window.innerWidth - 380,
          height: window.innerHeight - 150,
        });
        centerWorkspace(canvas, workspace);
      };
      window.addEventListener('resize', handleResize);

      setIsReady(true);
      console.log('[Studio] Canvas ready!');
      saveToHistory();

      return () => {
        window.removeEventListener('resize', handleResize);
        canvas.dispose();
      };
      } catch (err) {
        console.error('[Studio] Fabric init error:', err);
      }
    };

    initFabric();
    return () => { cancelled = true; };
  }, [sizePreset]);

  // Load initial photo
  useEffect(() => {
    if (!isReady || !initialPhoto || !fabricRef.current) return;
    addImageToCanvas(decodeURIComponent(initialPhoto));
  }, [isReady, initialPhoto]);

  // Load project data
  useEffect(() => {
    if (!isReady || !projectData?.project?.canvasData || !fabricRef.current) return;
    
    setProjectName(projectData.project.name);
    fabricRef.current.loadFromJSON(projectData.project.canvasData, () => {
      workspaceRef.current = fabricRef.current.getObjects().find((o: any) => o.isWorkspace);
      fabricRef.current.renderAll();
    });
  }, [isReady, projectData]);

  // Helper functions
  const centerWorkspace = (canvas: any, workspace: any) => {
    // Fabric.js v7: getCenter() removed → use canvas dimensions directly
    const center = { left: canvas.width / 2, top: canvas.height / 2 };
    workspace.set({
      left: center.left,
      top: center.top,
      originX: 'center',
      originY: 'center',
    });
    canvas.renderAll();
  };

  const saveToHistory = () => {
    if (!fabricRef.current) return;
    const json = JSON.stringify(fabricRef.current.toJSON(['isWorkspace']));
    setHistory((prev) => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(json);
      return newHistory.slice(-50); // Keep last 50 states
    });
    setHistoryIndex((prev) => Math.min(prev + 1, 49));
    setCanUndo(true);
    setCanRedo(false);
    // Trigger auto-save
    autoSave.markDirty();
  };

  const undo = () => {
    if (historyIndex <= 0 || !fabricRef.current) return;
    const newIndex = historyIndex - 1;
    fabricRef.current.loadFromJSON(JSON.parse(history[newIndex]), () => {
      workspaceRef.current = fabricRef.current.getObjects().find((o: any) => o.isWorkspace);
      fabricRef.current.renderAll();
    });
    setHistoryIndex(newIndex);
    setCanUndo(newIndex > 0);
    setCanRedo(true);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1 || !fabricRef.current) return;
    const newIndex = historyIndex + 1;
    fabricRef.current.loadFromJSON(JSON.parse(history[newIndex]), () => {
      workspaceRef.current = fabricRef.current.getObjects().find((o: any) => o.isWorkspace);
      fabricRef.current.renderAll();
    });
    setHistoryIndex(newIndex);
    setCanUndo(true);
    setCanRedo(newIndex < history.length - 1);
  };

  const addImageToCanvas = async (url: string) => {
    const fabric = await import('fabric');
    fabric.FabricImage.fromURL(url, { crossOrigin: 'anonymous' }).then((img: any) => {
      const ws = workspaceRef.current;
      if (!ws) return;

      // Scale to fit 80% of workspace
      const scale = Math.min(
        (ws.width * 0.8) / img.width,
        (ws.height * 0.8) / img.height
      );
      if (scale < 1) img.scale(scale);

      img.set({
        left: ws.left,
        top: ws.top,
        originX: 'center',
        originY: 'center',
      });

      fabricRef.current.add(img);
      fabricRef.current.setActiveObject(img);
      fabricRef.current.renderAll();
      saveToHistory();
    });
  };

  const addText = async () => {
    const fabric = await import('fabric');
    const ws = workspaceRef.current;
    if (!ws) return;

    const text = new fabric.IText('Текст', {
      left: ws.left,
      top: ws.top,
      originX: 'center',
      originY: 'center',
      fontSize: 48,
      fontFamily: 'Inter, sans-serif',
      fill: '#000000',
    });

    fabricRef.current.add(text);
    fabricRef.current.setActiveObject(text);
    fabricRef.current.renderAll();
    saveToHistory();
  };

  const addShape = async (type: 'rectangle' | 'circle') => {
    const fabric = await import('fabric');
    const ws = workspaceRef.current;
    if (!ws) return;

    let shape: any;
    const defaults = {
      left: ws.left,
      top: ws.top,
      originX: 'center' as const,
      originY: 'center' as const,
      fill: '#3b82f6',
      stroke: '#1d4ed8',
      strokeWidth: 2,
    };

    if (type === 'rectangle') {
      shape = new fabric.Rect({ ...defaults, width: 150, height: 100, rx: 8, ry: 8 });
    } else {
      shape = new fabric.Circle({ ...defaults, radius: 60 });
    }

    fabricRef.current.add(shape);
    fabricRef.current.setActiveObject(shape);
    fabricRef.current.renderAll();
    saveToHistory();
  };

  const deleteSelected = () => {
    const active = fabricRef.current?.getActiveObjects();
    if (!active?.length) return;

    active.forEach((obj: any) => {
      if (!obj.isWorkspace) fabricRef.current.remove(obj);
    });
    fabricRef.current.discardActiveObject();
    fabricRef.current.renderAll();
    saveToHistory();
  };

  const exportImage = (format: 'png' | 'jpeg' = 'png', quality: number = 0.9): string | null => {
    if (!fabricRef.current || !workspaceRef.current) return null;
    const ws = workspaceRef.current;

    return fabricRef.current.toDataURL({
      format,
      quality,
      left: ws.left - ws.width / 2,
      top: ws.top - ws.height / 2,
      width: ws.width,
      height: ws.height,
    });
  };

  const saveProject = () => {
    autoSave.forceSave();
  };

  const handleZoom = (delta: number) => {
    const newZoom = Math.max(0.25, Math.min(3, zoom + delta));
    setZoom(newZoom);
    if (fabricRef.current) {
      const center = fabricRef.current.getCenter();
      fabricRef.current.zoomToPoint({ x: center.left, y: center.top }, newZoom);
    }
  };

  // Tool buttons config
  const TOOLS = [
    { id: 'select', icon: MousePointer2, label: 'Выбор' },
    { id: 'text', icon: Type, label: 'Текст', action: addText },
    { id: 'rectangle', icon: Square, label: 'Прямоугольник', action: () => addShape('rectangle') },
    { id: 'circle', icon: Circle, label: 'Круг', action: () => addShape('circle') },
  ];

  return (
    <div className="flex h-full">
      {/* Left Toolbar */}
      <div className="w-14 border-r bg-background flex flex-col items-center py-2 gap-1">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            onClick={() => {
              setCurrentTool(tool.id as Tool);
              tool.action?.();
            }}
            className={`p-2.5 rounded-lg transition-colors ${
              currentTool === tool.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
            title={tool.label}
          >
            <tool.icon className="w-5 h-5" />
          </button>
        ))}

        <div className="border-t my-2 w-8" />

        <button
          onClick={() => document.getElementById('image-upload')?.click()}
          className="p-2.5 rounded-lg hover:bg-muted"
          title="Добавить изображение"
        >
          <ImageIcon className="w-5 h-5" />
        </button>
        <input
          id="image-upload"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              const url = URL.createObjectURL(file);
              addImageToCanvas(url);
            }
          }}
        />

        <div className="border-t my-2 w-8" />

        <button onClick={undo} disabled={!canUndo} className="p-2.5 rounded-lg hover:bg-muted disabled:opacity-30" title="Отменить">
          <Undo2 className="w-5 h-5" />
        </button>
        <button onClick={redo} disabled={!canRedo} className="p-2.5 rounded-lg hover:bg-muted disabled:opacity-30" title="Повторить">
          <Redo2 className="w-5 h-5" />
        </button>
        <button onClick={deleteSelected} className="p-2.5 rounded-lg hover:bg-muted text-destructive" title="Удалить">
          <Trash2 className="w-5 h-5" />
        </button>

        <div className="flex-1" />

        {/* Zoom controls */}
        <button onClick={() => handleZoom(0.1)} className="p-2.5 rounded-lg hover:bg-muted" title="Приблизить">
          <ZoomIn className="w-5 h-5" />
        </button>
        <span className="text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <button onClick={() => handleZoom(-0.1)} className="p-2.5 rounded-lg hover:bg-muted" title="Отдалить">
          <ZoomOut className="w-5 h-5" />
        </button>
        <button onClick={() => { setZoom(1); fabricRef.current?.setZoom(1); }} className="p-2.5 rounded-lg hover:bg-muted" title="Сбросить">
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Canvas Area */}
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-neutral-100 dark:bg-neutral-900">
        {!isReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}
        <canvas ref={canvasRef} />
      </div>

      {/* Right Panel */}
      <div className="w-80 border-l bg-background flex flex-col">
        {/* Project name & save */}
        <div className="p-4 border-b">
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="w-full font-medium bg-transparent border-b border-transparent hover:border-muted-foreground/30 focus:border-primary focus:outline-none pb-1"
          />
          <div className="flex gap-2 mt-3">
            <button
              onClick={saveProject}
              disabled={isSaving}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {autoSave.isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Сохранить
            </button>
            <button
              onClick={() => setShowExportModal(true)}
              className="px-3 py-2 border rounded-lg hover:bg-muted"
              title="Экспорт (Ctrl+E)"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
          <SaveStatus {...autoSave} />
        </div>

        {/* AI Panel */}
        <div className="border-b h-[400px]">
          <AIPanel
            selectedImageUrl={
              selectedObject?.type === 'image' 
                ? selectedObject.toDataURL?.() || selectedObject.getSrc?.()
                : undefined
            }
            onImageGenerated={(url) => addImageToCanvas(url)}
            onBackgroundRemoved={(url) => {
              // Replace selected image with the one without background
              if (selectedObject?.type === 'image') {
                addImageToCanvas(url).then(() => {
                  fabricRef.current?.remove(selectedObject);
                });
              } else {
                addImageToCanvas(url);
              }
            }}
          />
        </div>

        {/* Selected object properties */}
        {selectedObject && (
          <div className="p-4 border-b">
            <h3 className="font-medium mb-3">Свойства</h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Тип</span>
                <span>{selectedObject.type}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Ширина</span>
                <span>{Math.round(selectedObject.width * (selectedObject.scaleX || 1))}px</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Высота</span>
                <span>{Math.round(selectedObject.height * (selectedObject.scaleY || 1))}px</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Слой</span>
                <div className="flex gap-1 ml-auto">
                  <button
                    onClick={() => { fabricRef.current?.bringObjectForward(selectedObject); }}
                    className="p-1 hover:bg-muted rounded"
                    title="Вперёд"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => { fabricRef.current?.sendObjectBackwards(selectedObject); }}
                    className="p-1 hover:bg-muted rounded"
                    title="Назад"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Workspace size & shortcuts */}
        <div className="p-4 mt-auto border-t text-xs text-muted-foreground">
          <div className="flex justify-between items-center">
            <span>Размер холста</span>
            <span>{sizePreset.width} × {sizePreset.height}</span>
          </div>
          <div className="flex justify-between items-center mt-2">
            <span>Горячие клавиши</span>
            <ShortcutsHelpButton />
          </div>
        </div>
      </div>

      {/* Export Modal */}
      <ExportModal
        open={showExportModal}
        onClose={() => setShowExportModal(false)}
        exportCanvas={exportImage}
        projectId={currentProjectId || undefined}
        projectName={projectName}
        width={sizePreset.width}
        height={sizePreset.height}
      />
    </div>
  );
}

export default function EditorPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    }>
      <EditorContent />
    </Suspense>
  );
}
