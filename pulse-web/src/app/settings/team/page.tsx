'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  UserPlus,
  Users,
  Copy,
  Trash2,
  Shield,
  ShieldCheck,
  Eye,
  RefreshCw,
  LogOut,
  Clock,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
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
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SlowLoadingWarning } from '@/components/ui/SlowLoadingWarning';
import { useLoadingTimeout } from '@/hooks/useLoadingTimeout';
import { useWorkspaceStore } from '@/store/workspace';
import { WbUsersTab } from '@/components/team/WbUsersTab';

// Types
type Role = 'owner' | 'supervisor' | 'manager' | 'observer';

type Member = {
  userId: number;
  email: string;
  role: Role;
  invitedBy: number | null;
  createdAt: string;
};

type Invite = {
  inviteId: number;
  role: Role;
  token: string;
  expiresAt: string;
  createdAt: string;
};

type MyRole = {
  role: Role | null;
  isMember: boolean;
  permissions: {
    canManageTeam: boolean;
    canEditData: boolean;
    canRunOperations: boolean;
    canManageSubscription: boolean;
    canManageShops: boolean;
    canViewFinance: boolean;
  };
};

const roleLabels: Record<Role, string> = {
  owner: 'Владелец',
  supervisor: 'Руководитель',
  manager: 'Менеджер',
  observer: 'Наблюдатель',
};

const roleDescriptions: Record<Role, string> = {
  owner: 'Полный доступ, управление командой и подпиской',
  supervisor: 'Всё кроме подписки: финансы, ДДС, планы',
  manager: 'Работа с данными, без доступа к финансам',
  observer: 'Только просмотр',
};

const roleIcons: Record<Role, typeof Shield> = {
  owner: ShieldCheck,
  supervisor: Shield,
  manager: Shield,
  observer: Eye,
};

const roleColors: Record<Role, string> = {
  owner: 'text-yellow-700',
  supervisor: 'text-purple-600',
  manager: 'text-blue-600',
  observer: 'text-gray-600',
};

export default function TeamPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [myRole, setMyRole] = useState<MyRole | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showSlowWarning } = useLoadingTimeout(loading);

  // Invite form
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteRole, setInviteRole] = useState<'supervisor' | 'manager' | 'observer'>('observer');
  const [newInviteLink, setNewInviteLink] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'pulse' | 'wb'>('pulse');

  // Fetch data
  const fetchData = useCallback(async () => {
    if (!workspaceId || workspaceId <= 0) return;
    setLoading(true);
    setError(null);
    try {
      const [membersRes, myRoleRes] = await Promise.all([
        apiFetch<{ members: Member[] }>(`/team/${workspaceId}/members`),
        apiFetch<MyRole>(`/team/${workspaceId}/my-role`),
      ]);
      setMembers(membersRes.members);
      setMyRole(myRoleRes);

      // Fetch invites only if owner
      if (myRoleRes.permissions?.canManageTeam) {
        const invitesRes = await apiFetch<{ invites: Invite[] }>(`/team/${workspaceId}/invites`);
        setInvites(invitesRes.invites);
      }
    } catch (err: any) {
      console.error('Failed to fetch team data:', err);
      setError(err?.message ?? 'Не удалось загрузить данные команды');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Create invite
  const handleCreateInvite = async () => {
    if (!workspaceId || workspaceId <= 0) return;
    try {
      const res = await apiFetch<{ token: string }>(`/team/${workspaceId}/invite`, {
        method: 'POST',
        body: JSON.stringify({ role: inviteRole, expiresInDays: 7 }),
      });
      const link = `${window.location.origin}/join/${res.token}`;
      setNewInviteLink(link);
      fetchData();
    } catch (err) {
      console.error('Failed to create invite:', err);
    }
  };

  // Copy link
  const handleCopyLink = (link: string) => {
    navigator.clipboard.writeText(link);
  };

  // Delete invite
  const handleDeleteInvite = async (inviteId: number) => {
    if (!workspaceId || workspaceId <= 0) return;
    try {
      await apiFetch(`/team/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Failed to delete invite:', err);
    }
  };

  // Change role
  const handleChangeRole = async (userId: number, newRole: 'supervisor' | 'manager' | 'observer') => {
    if (!workspaceId || workspaceId <= 0) return;
    try {
      await apiFetch(`/team/${workspaceId}/members/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      fetchData();
    } catch (err) {
      console.error('Failed to change role:', err);
    }
  };

  // Remove member
  const handleRemoveMember = async (userId: number) => {
    if (!workspaceId || workspaceId <= 0) return;
    if (!confirm('Удалить этого участника из команды?')) return;
    try {
      await apiFetch(`/team/${workspaceId}/members/${userId}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Failed to remove member:', err);
    }
  };

  // Leave workspace
  const handleLeave = async () => {
    if (!workspaceId || workspaceId <= 0) return;
    if (!confirm('Вы уверены, что хотите покинуть этот workspace?')) return;
    try {
      await apiFetch(`/team/${workspaceId}/leave`, { method: 'POST' });
      // Redirect to home or workspace selection
      window.location.href = '/';
    } catch (err) {
      console.error('Failed to leave:', err);
    }
  };

  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">
          Выберите workspace
        </div>
      </AppShell>
    );
  }

  const canManage = myRole?.permissions?.canManageTeam ?? false;

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Slow Loading Warning */}
        {showSlowWarning && <SlowLoadingWarning onRetry={fetchData} />}

        {/* Error Banner */}
        <ErrorBanner error={error} onRetry={fetchData} onDismiss={() => setError(null)} />

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Users className="h-6 w-6" />
              Команда
            </h1>
            <p className="text-muted-foreground">
              Управление участниками workspace
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="neutral" onClick={fetchData} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
              Обновить
            </Button>
            {canManage && (
              <Button onClick={() => setShowInviteForm(!showInviteForm)} disabled={activeTab !== 'pulse'}>
                <UserPlus className="mr-2 h-4 w-4" />
                Пригласить
              </Button>
            )}
            {myRole?.role !== 'owner' && myRole?.isMember && (
              <Button variant="neutral" onClick={handleLeave}>
                <LogOut className="mr-2 h-4 w-4" />
                Покинуть
              </Button>
            )}
          </div>
        </div>

        {/* My Role Card */}
        {myRole && (
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="text-sm text-muted-foreground">Ваша роль:</div>
              {myRole.role && (
                <>
                  {(() => {
                    const Icon = roleIcons[myRole.role];
                    return <Icon className={cn('h-5 w-5', roleColors[myRole.role])} />;
                  })()}
                  <Badge variant="neutral">{roleLabels[myRole.role]}</Badge>
                </>
              )}
            </div>
          </Card>
        )}

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-200 pb-3">
          <button
            onClick={() => setActiveTab('pulse')}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              activeTab === 'pulse'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-500 hover:bg-gray-100'
            )}
          >
            <Users className="h-4 w-4" />
            Команда
          </button>
          <button
            onClick={() => setActiveTab('wb')}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              activeTab === 'wb'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-500 hover:bg-gray-100'
            )}
          >
            <Shield className="h-4 w-4" />
            Сотрудники WB
          </button>
        </div>

        {/* WB Users Tab */}
        {activeTab === 'wb' && workspaceId && (
          <WbUsersTab workspaceId={workspaceId} />
        )}

        {/* Pulse Team Content */}
        {activeTab === 'pulse' && (
        <>

        {/* Invite Form */}
        {showInviteForm && canManage && (
          <Card className="p-4">
            <h3 className="font-semibold mb-3">Создать приглашение</h3>
            <div className="flex gap-4 items-end">
              <div>
                <label className="text-sm text-muted-foreground">Роль</label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as 'supervisor' | 'manager' | 'observer')}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supervisor">Руководитель</SelectItem>
                    <SelectItem value="manager">Менеджер</SelectItem>
                    <SelectItem value="observer">Наблюдатель</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleCreateInvite}>Создать ссылку</Button>
            </div>

            {newInviteLink && (
              <div className="mt-4 p-3 bg-muted rounded-lg">
                <div className="text-sm text-muted-foreground mb-2">
                  Ссылка для приглашения (действует 7 дней):
                </div>
                <div className="flex gap-2">
                  <code className="flex-1 p-2 bg-background rounded text-sm truncate">
                    {newInviteLink}
                  </code>
                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => handleCopyLink(newInviteLink)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Pending Invites */}
        {canManage && invites.length > 0 && (
          <Card className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Активные приглашения
            </h3>
            <div className="space-y-2">
              {invites.map((invite) => (
                <div
                  key={invite.inviteId}
                  className="flex items-center justify-between p-2 bg-muted rounded"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="neutral">{roleLabels[invite.role]}</Badge>
                    <code className="text-xs text-muted-foreground">
                      {invite.token.slice(0, 8)}...
                    </code>
                    <span className="text-xs text-muted-foreground">
                      до {new Date(invite.expiresAt).toLocaleDateString('ru')}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        handleCopyLink(`${window.location.origin}/join/${invite.token}`)
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteInvite(invite.inviteId)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Members Table */}
        <Card>
          <div className="p-4 border-b">
            <h3 className="font-semibold">Участники ({members.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="p-3">Пользователь</th>
                  <th className="p-3">Роль</th>
                  <th className="p-3">Добавлен</th>
                  {canManage && <th className="p-3">Действия</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const Icon = roleIcons[member.role];
                  return (
                    <tr key={member.userId} className="border-b hover:bg-muted/50">
                      <td className="p-3">
                        <span className="font-medium">{member.email}</span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <Icon className={cn('h-4 w-4', roleColors[member.role])} />
                          {canManage && member.role !== 'owner' ? (
                            <Select
                              value={member.role}
                              onValueChange={(v) =>
                                handleChangeRole(member.userId, v as 'supervisor' | 'manager' | 'observer')
                              }
                            >
                              <SelectTrigger className="w-36 h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="supervisor">Руководитель</SelectItem>
                                <SelectItem value="manager">Менеджер</SelectItem>
                                <SelectItem value="observer">Наблюдатель</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <span>{roleLabels[member.role]}</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-sm text-muted-foreground">
                        {new Date(member.createdAt).toLocaleDateString('ru')}
                      </td>
                      {canManage && (
                        <td className="p-3">
                          {member.role !== 'owner' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveMember(member.userId)}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        </>
        )}
      </div>
    </AppShell>
  );
}
