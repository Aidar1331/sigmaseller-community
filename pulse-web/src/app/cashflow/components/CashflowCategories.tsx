'use client';

import { useCallback, useEffect, useState } from 'react';
import { FolderTree, Plus, Trash2, X, Edit2, Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';

// Types
type Category = {
  categoryId: number;
  code: string;
  name: string;
  parentCode: string | null;
  type: 'income' | 'expense';
  icon: string | null;
  color: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  children?: Category[];
};

type Props = {
  workspaceId: number;
  onClose: () => void;
};

export function CashflowCategories({ workspaceId, onClose }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeType, setActiveType] = useState<'expense' | 'income'>('expense');
  
  // New category form
  const [newCategory, setNewCategory] = useState({
    code: '',
    name: '',
    type: 'expense' as 'income' | 'expense',
    parentCode: '',
    icon: '📦',
  });

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const cats = await apiFetch(`/cashflow/${workspaceId}/categories`) as Category[];
      setCategories(cats);
    } catch (err) {
      console.error('Failed to fetch categories:', err);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Add category
  const handleAddCategory = async () => {
    if (!newCategory.code || !newCategory.name) return;
    try {
      await apiFetch(`/cashflow/${workspaceId}/categories`, {
        method: 'POST',
        body: JSON.stringify({
          code: newCategory.code,
          name: newCategory.name,
          type: newCategory.type,
          parentCode: newCategory.parentCode || undefined,
          icon: newCategory.icon,
        }),
      });
      setNewCategory({ code: '', name: '', type: 'expense', parentCode: '', icon: '📦' });
      fetchData();
    } catch (err) {
      console.error('Failed to add category:', err);
    }
  };

  // Delete category
  const handleDeleteCategory = async (categoryId: number) => {
    if (!confirm('Удалить эту категорию?')) return;
    try {
      await apiFetch(`/cashflow/${workspaceId}/categories/${categoryId}`, { method: 'DELETE' });
      fetchData();
    } catch (err: any) {
      if (err.message?.includes('system')) {
        alert('Нельзя удалить системную категорию');
      }
    }
  };

  const filteredCategories = categories.filter(c => c.type === activeType);

  // Get parent categories for select
  const parentOptions = categories
    .filter(c => c.type === newCategory.type && !c.parentCode)
    .map(c => ({ code: c.code, name: c.name }));

  return (
    <Card className="p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-muted/30">
        <h3 className="font-semibold flex items-center gap-2">
          <FolderTree className="h-5 w-5" />
          Категории расходов и доходов
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Type Tabs */}
      <div className="flex border-b">
        <button
          onClick={() => setActiveType('expense')}
          className={cn(
            'flex-1 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeType === 'expense'
              ? 'border-red-500 text-red-600'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          💸 Расходы
        </button>
        <button
          onClick={() => setActiveType('income')}
          className={cn(
            'flex-1 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeType === 'income'
              ? 'border-green-500 text-green-700'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          💰 Доходы
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {/* Add form */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 items-end">
          <div>
            <label className="text-xs text-muted-foreground">Название</label>
            <Input
              placeholder="Аренда офиса"
              value={newCategory.name}
              onChange={(e) => {
                const name = e.target.value;
                // Auto-generate code from name
                const code = name.toLowerCase()
                  .replace(/[^a-zа-яё0-9\s]/gi, '')
                  .replace(/\s+/g, '_')
                  .slice(0, 30) || 'category';
                setNewCategory({ ...newCategory, name, code });
              }}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Тип</label>
            <Select
              value={newCategory.type}
              onValueChange={(v) => setNewCategory({ ...newCategory, type: v as 'income' | 'expense', parentCode: '' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">Расход</SelectItem>
                <SelectItem value="income">Доход</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Родитель</label>
            <Select
              value={newCategory.parentCode || '_none_'}
              onValueChange={(v) => setNewCategory({ ...newCategory, parentCode: v === '_none_' ? '' : v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Нет" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none_">Нет (корневая)</SelectItem>
                {parentOptions.map((p) => (
                  <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleAddCategory} disabled={!newCategory.code || !newCategory.name}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Categories tree */}
        <div className="space-y-2">
          {filteredCategories.map((cat) => (
            <div key={cat.categoryId}>
              {/* Parent category */}
              <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{cat.icon || '📁'}</span>
                  <span className="font-medium">{cat.name}</span>
                  {cat.isSystem && <Badge variant="neutral">Системная</Badge>}
                </div>
                {!cat.isSystem && (
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteCategory(cat.categoryId)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                )}
              </div>
              
              {/* Children */}
              {cat.children && cat.children.length > 0 && (
                <div className="ml-6 mt-1 space-y-1">
                  {cat.children.map((child) => (
                    <div key={child.categoryId} className="flex items-center justify-between p-2 bg-muted/30 rounded">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{child.icon || '📄'}</span>
                        <span>{child.name}</span>
                      </div>
                      {!child.isSystem && (
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteCategory(child.categoryId)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          
          {filteredCategories.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              Нет категорий
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
