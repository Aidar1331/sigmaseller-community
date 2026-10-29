'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Palette,
  Trash2,
  Copy,
  MoreVertical,
  Loader2,
  FolderOpen,
  Plus,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';

interface Project {
  projectId: number;
  name: string;
  type: string;
  status: string;
  thumbnail: string | null;
  createdAt: string;
  updatedAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  image: 'Изображение',
  infographic: 'Инфографика',
  rich_content: 'Rich Content',
  animation: 'Анимация',
};

export default function ProjectsPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openMenu, setOpenMenu] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['studio-projects', workspaceId],
    queryFn: () => apiFetch(`/studio/projects?workspaceId=${workspaceId}&limit=100`),
    enabled: !!workspaceId,
  });

  const deleteMutation = useMutation({
    mutationFn: (projectId: number) =>
      apiFetch(`/studio/projects/${projectId}?workspaceId=${workspaceId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio-projects'] });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (projectId: number) =>
      apiFetch(`/studio/projects/${projectId}/duplicate?workspaceId=${workspaceId}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio-projects'] });
    },
  });

  const handleDelete = (projectId: number) => {
    if (confirm('Удалить проект?')) {
      deleteMutation.mutate(projectId);
    }
    setOpenMenu(null);
  };

  const handleDuplicate = (projectId: number) => {
    duplicateMutation.mutate(projectId);
    setOpenMenu(null);
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Мои проекты</h1>
        <button
          onClick={() => router.push('/studio/editor')}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Новый проект
        </button>
      </div>

      {/* Projects Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : !data?.projects?.length ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <FolderOpen className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-muted-foreground mb-4">Нет сохранённых проектов</p>
          <button
            onClick={() => router.push('/studio/editor')}
            className="text-sm text-primary hover:underline"
          >
            Создать первый проект →
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {data.projects.map((project: Project) => (
            <div
              key={project.projectId}
              className="group relative border rounded-lg overflow-hidden bg-card hover:border-primary transition-colors"
            >
              {/* Thumbnail */}
              <div
                className="aspect-[3/4] bg-muted cursor-pointer"
                onClick={() => router.push(`/studio/editor?projectId=${project.projectId}`)}
              >
                {project.thumbnail ? (
                  <img
                    src={project.thumbnail}
                    alt={project.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Palette className="w-10 h-10 text-muted-foreground/30" />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <p className="font-medium truncate">{project.name}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-muted-foreground">
                    {TYPE_LABELS[project.type] || project.type}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(project.updatedAt).toLocaleDateString('ru')}
                  </span>
                </div>
              </div>

              {/* Menu */}
              <div className="absolute top-2 right-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenu(openMenu === project.projectId ? null : project.projectId);
                  }}
                  className="p-1.5 bg-background/80 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>

                {openMenu === project.projectId && (
                  <div className="absolute top-full right-0 mt-1 py-1 bg-popover border rounded-lg shadow-lg z-10 min-w-[140px]">
                    <button
                      onClick={() => handleDuplicate(project.projectId)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2"
                    >
                      <Copy className="w-4 h-4" />
                      Дублировать
                    </button>
                    <button
                      onClick={() => handleDelete(project.projectId)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2 text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
