'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { apiFetch } from '@/lib/api';
import {
  Users, Plus, RefreshCw, Edit2, Trash2, Mail,
  Shield, UserCheck, UserX, Save, X
} from 'lucide-react';
import { cn } from '@/lib/cn';

type WbUser = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: string;
  permissions: string[];
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string;
};

type WbRole = {
  id: number;
  name: string;
  description: string;
};

interface WbUsersTabProps {
  workspaceId: number;
}

export function WbUsersTab({ workspaceId }: WbUsersTabProps) {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<WbUser[]>([]);
  const [roles, setRoles] = useState<WbRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<Partial<WbUser> | null>(null);
  const [isInviting, setIsInviting] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        apiFetch(`/team/${workspaceId}/wb-users`) as Promise<{ users: WbUser[] }>,
        apiFetch(`/team/${workspaceId}/wb-roles`) as Promise<{ roles: WbRole[] }>,
      ]);
      setUsers(usersRes.users ?? []);
      setRoles(rolesRes.roles ?? []);
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const inviteUser = async () => {
    if (!editingUser?.email || !editingUser?.firstName || !editingUser?.lastName) {
      setError('Заполните все обязательные поля');
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/team/${workspaceId}/wb-users`, {
        method: 'POST',
        body: JSON.stringify(editingUser),
      });
      setEditingUser(null);
      setIsInviting(false);
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось пригласить пользователя');
    } finally {
      setSaving(false);
    }
  };

  const updateUser = async (userId: number) => {
    if (!editingUser) return;
    setSaving(true);
    try {
      await apiFetch(`/team/${workspaceId}/wb-users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(editingUser),
      });
      setEditingUser(null);
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось обновить пользователя');
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async (userId: number) => {
    if (!confirm('Удалить пользователя из WB аккаунта?')) return;
    try {
      await apiFetch(`/team/${workspaceId}/wb-users/${userId}`, {
        method: 'DELETE',
      });
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось удалить пользователя');
    }
  };

  const toggleActive = async (user: WbUser) => {
    setSaving(true);
    try {
      await apiFetch(`/team/${workspaceId}/wb-users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось изменить статус');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-gray-900">Сотрудники WB</h3>
          <p className="text-sm text-gray-500">Пользователи в вашем аккаунте продавца Wildberries</p>
        </div>
        <div className="flex gap-2">
          <Button variant="neutral" size="sm" onClick={loadData} loading={loading}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setIsInviting(true);
              setEditingUser({ email: '', firstName: '', lastName: '' });
            }}
          >
            <Plus className="h-4 w-4" />
            Пригласить
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={() => setError(null)} className="text-xs text-red-500 underline mt-1">
            Скрыть
          </button>
        </Card>
      )}

      {/* Invite form */}
      {isInviting && editingUser && (
        <Card className="p-4 border-indigo-200 bg-indigo-50/30">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-medium text-gray-900">Пригласить сотрудника</h4>
            <button onClick={() => { setIsInviting(false); setEditingUser(null); }} className="p-1 rounded hover:bg-gray-200">
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
              <Input
                type="email"
                value={editingUser.email || ''}
                onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })}
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Имя *</label>
              <Input
                value={editingUser.firstName || ''}
                onChange={(e) => setEditingUser({ ...editingUser, firstName: e.target.value })}
                placeholder="Иван"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Фамилия *</label>
              <Input
                value={editingUser.lastName || ''}
                onChange={(e) => setEditingUser({ ...editingUser, lastName: e.target.value })}
                placeholder="Иванов"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <Button variant="neutral" size="sm" onClick={() => { setIsInviting(false); setEditingUser(null); }}>
              Отмена
            </Button>
            <Button variant="primary" size="sm" onClick={inviteUser} loading={saving}>
              <Mail className="h-4 w-4" />
              Отправить приглашение
            </Button>
          </div>
        </Card>
      )}

      {/* Users list */}
      {loading ? (
        <Card className="p-8 text-center text-gray-500">Загрузка...</Card>
      ) : users.length === 0 ? (
        <Card className="p-8 text-center text-gray-500">
          <Users className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p>Нет сотрудников в WB аккаунте</p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {users.map((user) => (
            <Card key={user.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={cn(
                    'h-10 w-10 rounded-full flex items-center justify-center text-white font-medium',
                    user.isActive ? 'bg-indigo-500' : 'bg-gray-400'
                  )}>
                    {user.firstName[0]}{user.lastName[0]}
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">
                      {user.firstName} {user.lastName}
                    </div>
                    <div className="text-sm text-gray-500">{user.email}</div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Badge variant={user.isActive ? 'success' : 'secondary'}>
                    {user.isActive ? 'Активен' : 'Неактивен'}
                  </Badge>
                  <Badge variant="info">
                    <Shield className="h-3 w-3 mr-1" />
                    {user.role}
                  </Badge>

                  <div className="flex gap-1">
                    <Button
                      variant="neutral"
                      size="sm"
                      onClick={() => toggleActive(user)}
                      title={user.isActive ? 'Деактивировать' : 'Активировать'}
                    >
                      {user.isActive ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => deleteUser(user.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {user.lastLoginAt && (
                <div className="mt-2 text-xs text-gray-500">
                  Последний вход: {new Date(user.lastLoginAt).toLocaleString('ru-RU')}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
