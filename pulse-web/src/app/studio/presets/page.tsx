'use client';

import { useState } from 'react';
import {
  Settings,
  Plus,
  Trash2,
  Edit2,
  Star,
  Loader2,
  Camera,
  Sun,
  Palette,
  User,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

interface Preset {
  presetId: number;
  name: string;
  category: string | null;
  settings: {
    camera?: string;
    lighting?: string;
    style?: string;
    pose?: string;
    background?: string;
    prompt_template?: string;
  };
  isSystem: boolean;
  isDefault: boolean;
}

const CATEGORY_LABELS: Record<string, { label: string; icon: any }> = {
  studio: { label: 'Студия', icon: Camera },
  lifestyle: { label: 'Lifestyle', icon: Sun },
  product: { label: 'Продукт', icon: Palette },
  clothing: { label: 'Одежда', icon: User },
};

const CAMERA_OPTIONS = [
  { value: 'front', label: 'Фронтально' },
  { value: 'angle_45', label: '45° сбоку' },
  { value: 'top_down', label: 'Сверху' },
  { value: 'hero_shot', label: 'Hero shot (снизу)' },
  { value: 'isometric', label: 'Изометрия' },
];

const LIGHTING_OPTIONS = [
  { value: 'studio_3point', label: 'Студия (3 точки)' },
  { value: 'natural', label: 'Естественный' },
  { value: 'soft_diffused', label: 'Мягкий рассеянный' },
  { value: 'dramatic', label: 'Драматичный' },
  { value: 'backlight', label: 'Контровой' },
];

const STYLE_OPTIONS = [
  { value: 'professional', label: 'Профессиональный' },
  { value: 'casual', label: 'Повседневный' },
  { value: 'luxury', label: 'Premium / Luxury' },
  { value: 'minimal', label: 'Минимализм' },
  { value: 'fashion', label: 'Fashion' },
];

export default function PresetsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const queryClient = useQueryClient();
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['studio-presets', workspaceId],
    queryFn: () => apiFetch(`/studio/presets?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });

  const createMutation = useMutation({
    mutationFn: (preset: Partial<Preset>) =>
      apiFetch(`/studio/presets?workspaceId=${workspaceId}`, {
        method: 'POST',
        body: JSON.stringify(preset),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio-presets'] });
      setIsCreating(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ presetId, ...data }: Partial<Preset> & { presetId: number }) =>
      apiFetch(`/studio/presets/${presetId}?workspaceId=${workspaceId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio-presets'] });
      setEditingPreset(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (presetId: number) =>
      apiFetch(`/studio/presets/${presetId}?workspaceId=${workspaceId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio-presets'] });
    },
  });

  const handleSave = (preset: Partial<Preset>) => {
    if (editingPreset) {
      updateMutation.mutate({ presetId: editingPreset.presetId, ...preset });
    } else {
      createMutation.mutate(preset);
    }
  };

  const systemPresets = data?.presets?.filter((p: Preset) => p.isSystem) || [];
  const userPresets = data?.presets?.filter((p: Preset) => !p.isSystem) || [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Пресеты генерации</h1>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" />
          Создать пресет
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="space-y-8">
          {/* System presets */}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
              <Star className="w-4 h-4" />
              Системные пресеты
            </h2>
            <div className="grid gap-3">
              {systemPresets.map((preset: Preset) => (
                <PresetCard key={preset.presetId} preset={preset} />
              ))}
            </div>
          </div>

          {/* User presets */}
          {userPresets.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-3">Мои пресеты</h2>
              <div className="grid gap-3">
                {userPresets.map((preset: Preset) => (
                  <PresetCard
                    key={preset.presetId}
                    preset={preset}
                    onEdit={() => setEditingPreset(preset)}
                    onDelete={() => {
                      if (confirm('Удалить пресет?')) {
                        deleteMutation.mutate(preset.presetId);
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create/Edit Modal */}
      {(isCreating || editingPreset) && (
        <PresetModal
          preset={editingPreset}
          onSave={handleSave}
          onClose={() => {
            setIsCreating(false);
            setEditingPreset(null);
          }}
          isLoading={createMutation.isPending || updateMutation.isPending}
        />
      )}
    </div>
  );
}

function PresetCard({
  preset,
  onEdit,
  onDelete,
}: {
  preset: Preset;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const category = CATEGORY_LABELS[preset.category || 'studio'] || CATEGORY_LABELS.studio;
  const Icon = category.icon;

  return (
    <div className="flex items-center gap-4 p-4 border rounded-lg bg-card">
      <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
        <Icon className="w-5 h-5 text-primary" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{preset.name}</span>
          {preset.isDefault && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
              По умолчанию
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground truncate">
          {[
            preset.settings.camera && `📷 ${CAMERA_OPTIONS.find((o) => o.value === preset.settings.camera)?.label}`,
            preset.settings.lighting && `💡 ${LIGHTING_OPTIONS.find((o) => o.value === preset.settings.lighting)?.label}`,
            preset.settings.style && `🎨 ${STYLE_OPTIONS.find((o) => o.value === preset.settings.style)?.label}`,
          ]
            .filter(Boolean)
            .join(' • ')}
        </p>
      </div>

      {!preset.isSystem && (
        <div className="flex gap-1">
          <button onClick={onEdit} className="p-2 hover:bg-muted rounded-lg" title="Редактировать">
            <Edit2 className="w-4 h-4" />
          </button>
          <button onClick={onDelete} className="p-2 hover:bg-muted rounded-lg text-destructive" title="Удалить">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function PresetModal({
  preset,
  onSave,
  onClose,
  isLoading,
}: {
  preset: Preset | null;
  onSave: (data: Partial<Preset>) => void;
  onClose: () => void;
  isLoading: boolean;
}) {
  const [name, setName] = useState(preset?.name || '');
  const [category, setCategory] = useState(preset?.category || 'studio');
  const [camera, setCamera] = useState(preset?.settings.camera || 'front');
  const [lighting, setLighting] = useState(preset?.settings.lighting || 'studio_3point');
  const [style, setStyle] = useState(preset?.settings.style || 'professional');
  const [background, setBackground] = useState(preset?.settings.background || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name,
      category,
      settings: { camera, lighting, style, background },
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-xl w-full max-w-md max-h-[90vh] overflow-auto">
        <form onSubmit={handleSubmit}>
          <div className="p-6 border-b">
            <h2 className="text-lg font-bold">{preset ? 'Редактировать пресет' : 'Новый пресет'}</h2>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="text-sm font-medium">Название</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded-lg"
                required
              />
            </div>

            <div>
              <label className="text-sm font-medium">Категория</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded-lg"
              >
                {Object.entries(CATEGORY_LABELS).map(([value, { label }]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Камера</label>
              <select
                value={camera}
                onChange={(e) => setCamera(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded-lg"
              >
                {CAMERA_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Освещение</label>
              <select
                value={lighting}
                onChange={(e) => setLighting(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded-lg"
              >
                {LIGHTING_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Стиль</label>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded-lg"
              >
                {STYLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Фон (описание)</label>
              <input
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                placeholder="Например: белый градиент, мраморная столешница..."
                className="w-full mt-1 px-3 py-2 border rounded-lg"
              />
            </div>
          </div>

          <div className="p-6 border-t flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isLoading || !name}
              className="flex-1 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {isLoading ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
