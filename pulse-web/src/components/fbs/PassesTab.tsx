'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import {
  Key, Plus, RefreshCw, Edit2, Trash2, Calendar,
  Truck, MapPin, Clock, Save, X
} from 'lucide-react';
import { cn } from '@/lib/cn';

type Pass = {
  passId: number;
  firstName: string;
  lastName: string;
  carModel: string | null;
  carNumber: string | null;
  warehouseId: number | null;
  warehouseName: string | null;
  dateFrom: string;
  dateTo: string;
  status: string;
};

interface PassesTabProps {
  workspaceId: number;
}

export function PassesTab({ workspaceId }: PassesTabProps) {
  const [loading, setLoading] = useState(false);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingPass, setEditingPass] = useState<Partial<Pass> | null>(null);
  const [saving, setSaving] = useState(false);

  const loadPasses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/fbs/${workspaceId}/passes`) as { passes: Pass[] };
      setPasses(res.passes ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить пропуска');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadPasses();
  }, [loadPasses]);

  const createPass = async () => {
    if (!editingPass) return;
    setSaving(true);
    try {
      await apiFetch(`/fbs/${workspaceId}/passes`, {
        method: 'POST',
        body: JSON.stringify(editingPass),
      });
      setEditingPass(null);
      await loadPasses();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось создать пропуск');
    } finally {
      setSaving(false);
    }
  };

  const updatePass = async (passId: number) => {
    if (!editingPass) return;
    setSaving(true);
    try {
      await apiFetch(`/fbs/${workspaceId}/passes/${passId}`, {
        method: 'PUT',
        body: JSON.stringify(editingPass),
      });
      setEditingPass(null);
      await loadPasses();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось обновить пропуск');
    } finally {
      setSaving(false);
    }
  };

  const deletePass = async (passId: number) => {
    if (!confirm('Удалить пропуск?')) return;
    try {
      await apiFetch(`/fbs/${workspaceId}/passes/${passId}`, {
        method: 'DELETE',
      });
      await loadPasses();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось удалить пропуск');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="success">Активен</Badge>;
      case 'expired':
        return <Badge variant="secondary">Истёк</Badge>;
      case 'pending':
        return <Badge variant="warning">Ожидает</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const isExpired = (dateTo: string) => {
    return new Date(dateTo) < new Date();
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-gray-900">Пропуска на склады WB</h3>
          <p className="text-sm text-gray-500">Управление пропусками для водителей</p>
        </div>
        <div className="flex gap-2">
          <Button variant="neutral" size="sm" onClick={loadPasses} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            Обновить
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setEditingPass({
              firstName: '',
              lastName: '',
              carModel: '',
              carNumber: '',
              dateFrom: new Date().toISOString().slice(0, 10),
              dateTo: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            })}
          >
            <Plus className="h-4 w-4" />
            Новый пропуск
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-600">{error}</p>
        </Card>
      )}

      {/* Edit/Create form */}
      {editingPass && (
        <Card className="p-4 border-indigo-200 bg-indigo-50/30">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-medium text-gray-900">
              {editingPass.passId ? 'Редактировать пропуск' : 'Новый пропуск'}
            </h4>
            <button
              onClick={() => setEditingPass(null)}
              className="p-1 rounded hover:bg-gray-200"
            >
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Имя</label>
              <Input
                value={editingPass.firstName || ''}
                onChange={(e) => setEditingPass({ ...editingPass, firstName: e.target.value })}
                placeholder="Иван"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Фамилия</label>
              <Input
                value={editingPass.lastName || ''}
                onChange={(e) => setEditingPass({ ...editingPass, lastName: e.target.value })}
                placeholder="Иванов"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Марка авто</label>
              <Input
                value={editingPass.carModel || ''}
                onChange={(e) => setEditingPass({ ...editingPass, carModel: e.target.value })}
                placeholder="ГАЗель NEXT"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Номер авто</label>
              <Input
                value={editingPass.carNumber || ''}
                onChange={(e) => setEditingPass({ ...editingPass, carNumber: e.target.value })}
                placeholder="А123БВ777"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Дата начала</label>
              <Input
                type="date"
                value={editingPass.dateFrom?.slice(0, 10) || ''}
                onChange={(e) => setEditingPass({ ...editingPass, dateFrom: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Дата окончания</label>
              <Input
                type="date"
                value={editingPass.dateTo?.slice(0, 10) || ''}
                onChange={(e) => setEditingPass({ ...editingPass, dateTo: e.target.value })}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <Button variant="neutral" size="sm" onClick={() => setEditingPass(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => editingPass.passId ? updatePass(editingPass.passId) : createPass()}
              loading={saving}
            >
              <Save className="h-4 w-4" />
              {editingPass.passId ? 'Сохранить' : 'Создать'}
            </Button>
          </div>
        </Card>
      )}

      {/* Passes list */}
      {loading ? (
        <Card className="p-8 text-center text-gray-500">Загрузка...</Card>
      ) : passes.length === 0 ? (
        <Card className="p-8 text-center text-gray-500">
          <Key className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p>Нет активных пропусков</p>
          <p className="text-xs mt-2">Создайте пропуск для въезда на склад WB</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {passes.map((pass) => (
            <Card
              key={pass.passId}
              className={cn(
                'p-4',
                isExpired(pass.dateTo) && 'opacity-60'
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-indigo-100 flex items-center justify-center">
                    <Key className="h-5 w-5 text-indigo-600" />
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">
                      {pass.firstName} {pass.lastName}
                    </div>
                    {pass.warehouseName && (
                      <div className="flex items-center gap-1 text-sm text-gray-500">
                        <MapPin className="h-3 w-3" />
                        {pass.warehouseName}
                      </div>
                    )}
                  </div>
                </div>
                {getStatusBadge(isExpired(pass.dateTo) ? 'expired' : pass.status)}
              </div>

              <div className="mt-4 space-y-2">
                {(pass.carModel || pass.carNumber) && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Truck className="h-4 w-4 text-gray-500" />
                    {pass.carModel} {pass.carNumber && `• ${pass.carNumber}`}
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Calendar className="h-4 w-4 text-gray-500" />
                  {new Date(pass.dateFrom).toLocaleDateString('ru-RU')} — {new Date(pass.dateTo).toLocaleDateString('ru-RU')}
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() => setEditingPass(pass)}
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => deletePass(pass.passId)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
