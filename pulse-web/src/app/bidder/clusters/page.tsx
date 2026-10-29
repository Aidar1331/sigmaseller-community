'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Layers,
  RefreshCw,
  ArrowLeft,
  BarChart3,
  MinusCircle,
  Loader2,
  AlertCircle,
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
import { ClusterTable, Cluster, ClusterBid } from '../components/ClusterTable';
import { MinusPhrases } from '../components/MinusPhrases';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Paywall } from '@/components/Paywall';
import { cn } from '@/lib/cn';

type Campaign = {
  campaignId: number;
  advertId: number;
  name: string;
  status: number;
  type: number;
};

type Tab = 'clusters' | 'minus';

function ClustersPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const storeWorkspaceId = useWorkspaceStore((s) => s.workspaceId);
  const workspaceId = storeWorkspaceId ?? undefined;

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<number | null>(
    searchParams.get('advertId') ? Number(searchParams.get('advertId')) : null
  );
  const [activeTab, setActiveTab] = useState<Tab>('clusters');

  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [bids, setBids] = useState<ClusterBid[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [minusPhrases, setMinusPhrases] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check subscription
  // Always allow access - paywall is handled by Paywall component if needed
  const hasAccess = true;

  // Load campaigns
  const loadCampaigns = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/bidder/${workspaceId}/campaigns`);
      const activeCampaigns = (res.campaigns || []).filter(
        (c: Campaign) => c.status === 9 || c.status === 11
      );
      setCampaigns(activeCampaigns);

      // Auto-select first campaign if none selected
      if (!selectedCampaign && activeCampaigns.length > 0) {
        setSelectedCampaign(activeCampaigns[0].advertId);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedCampaign]);

  // Load cluster data for selected campaign
  const loadClusterData = useCallback(async () => {
    if (!workspaceId || !selectedCampaign) return;
    setLoadingData(true);
    setError(null);

    try {
      const [clustersRes, bidsRes, statsRes] = await Promise.all([
        apiFetch(`/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters`),
        apiFetch(`/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/bids`),
        apiFetch(`/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/stats`),
      ]);

      if (clustersRes.error) {
        setError(clustersRes.error);
      } else {
        setClusters(clustersRes.clusters || []);
      }

      setBids(bidsRes.bids || []);
      setStats(statsRes.stats || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingData(false);
    }
  }, [workspaceId, selectedCampaign]);

  // Load minus phrases
  const loadMinusPhrases = useCallback(async () => {
    if (!workspaceId || !selectedCampaign) return;
    try {
      const res = await apiFetch(
        `/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/minus`
      );
      setMinusPhrases(res.excluded || []);
    } catch (e) {
      console.error('Failed to load minus phrases:', e);
    }
  }, [workspaceId, selectedCampaign]);

  // Initial load
  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  // Load data when campaign selected
  useEffect(() => {
    if (selectedCampaign) {
      loadClusterData();
      loadMinusPhrases();
    }
  }, [selectedCampaign, loadClusterData, loadMinusPhrases]);

  // Handlers
  const handleSetBids = async (newBids: ClusterBid[]) => {
    if (!workspaceId || !selectedCampaign) return;
    await apiFetch(`/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/bids`, {
      method: 'POST',
      body: JSON.stringify({ bids: newBids }),
    });
    // Reload bids
    const bidsRes = await apiFetch(
      `/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/bids`
    );
    setBids(bidsRes.bids || []);
  };

  const handleResetBids = async (clusterIds: number[]) => {
    if (!workspaceId || !selectedCampaign) return;
    await apiFetch(`/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/bids`, {
      method: 'DELETE',
      body: JSON.stringify({ clusters: clusterIds }),
    });
    // Reload bids
    const bidsRes = await apiFetch(
      `/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/bids`
    );
    setBids(bidsRes.bids || []);
  };

  const handleSaveMinusPhrases = async (phrases: string[]) => {
    if (!workspaceId || !selectedCampaign) return;
    await apiFetch(`/bidder/${workspaceId}/campaigns/${selectedCampaign}/clusters/minus`, {
      method: 'POST',
      body: JSON.stringify({ excluded: phrases }),
    });
    setMinusPhrases(phrases);
  };

  const handleCampaignChange = (value: string) => {
    const advertId = Number(value);
    setSelectedCampaign(advertId);
    router.push(`/bidder/clusters?advertId=${advertId}`);
  };

  if (!hasAccess) {
    return (
      <AppShell>
        <Paywall workspaceId={workspaceId ?? 0} feature="Кластеры биддера">
          <div className="p-8 text-center text-gray-500">Загрузка...</div>
        </Paywall>
      </AppShell>
    );
  }

  const selectedCampaignData = campaigns.find((c) => c.advertId === selectedCampaign);

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/bidder')}
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Биддер
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Layers className="h-6 w-6 text-purple-500" />
                Поисковые кластеры
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                Управление ставками по группам поисковых запросов
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              loadClusterData();
              loadMinusPhrases();
            }}
            disabled={loadingData}
          >
            <RefreshCw className={cn('h-4 w-4 mr-1', loadingData && 'animate-spin')} />
            Обновить
          </Button>
        </div>

        {error && <ErrorBanner error={error} />}

        {/* Campaign selector */}
        <Card className="p-4">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium">Кампания:</label>
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
            ) : campaigns.length === 0 ? (
              <div className="flex items-center gap-2 text-gray-500">
                <AlertCircle className="h-4 w-4" />
                <span>Нет активных кампаний</span>
              </div>
            ) : (
              <Select
                value={String(selectedCampaign || '')}
                onValueChange={handleCampaignChange}
              >
                <SelectTrigger className="w-80">
                  <SelectValue placeholder="Выберите кампанию" />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map((c) => (
                    <SelectItem key={c.advertId} value={String(c.advertId)}>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={c.status === 9 ? 'success' : 'secondary'}
                          className="text-xs"
                        >
                          {c.status === 9 ? 'Active' : 'Paused'}
                        </Badge>
                        <span className="truncate max-w-[200px]">{c.name}</span>
                        <span className="text-gray-500">#{c.advertId}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </Card>

        {/* Tabs */}
        {selectedCampaign && (
          <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={() => setActiveTab('clusters')}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === 'clusters'
                  ? 'border-purple-500 text-purple-600 dark:text-purple-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              <BarChart3 className="h-4 w-4 inline mr-2" />
              Кластеры ({clusters.length})
            </button>
            <button
              onClick={() => setActiveTab('minus')}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === 'minus'
                  ? 'border-purple-500 text-purple-600 dark:text-purple-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              <MinusCircle className="h-4 w-4 inline mr-2" />
              Минус-фразы ({minusPhrases.length})
            </button>
          </div>
        )}

        {/* Content */}
        {selectedCampaign && (
          <Card className="p-6">
            {activeTab === 'clusters' && (
              <ClusterTable
                clusters={clusters}
                bids={bids}
                stats={stats}
                onSetBids={handleSetBids}
                onResetBids={handleResetBids}
                loading={loadingData}
              />
            )}
            {activeTab === 'minus' && (
              <MinusPhrases
                phrases={minusPhrases}
                onSave={handleSaveMinusPhrases}
                loading={loadingData}
              />
            )}
          </Card>
        )}
      </div>
    </AppShell>
  );
}

export default function ClustersPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        </AppShell>
      }
    >
      <ClustersPageContent />
    </Suspense>
  );
}
