'use client';

import { useCallback } from 'react';
import { usePulsePage, usePulseEvents } from '@/hooks';
import { useWorkspaceStore } from '@/store/workspace';
import { AppShell } from '@/components/AppShell';
import { SyncFreshnessBadge } from '@/components/SyncFreshnessBadge';
import {
  PulseKPICards,
  SavePresetModal,
  EventEditModal,
  EventCreateModal,
  ContextMenu,
  HoverTip,
  EventsCalendarMini,
  PulseHeatmapTable,
  SettingsSidebar,
  QuickFilterBar,
  WbClubCard,
} from '@/components/pulse';
import { AiAnalyzeButton } from '@/components/ai';

export default function PulsePage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const activeShopId = useWorkspaceStore((s) => s.shopId);
  const page = usePulsePage();

  // Compute dateKeys before hooks (may be empty array)
  const dateKeys = page.overview?.series?.map(s => s.key) ?? [];

  // All hooks MUST be called before any conditional return
  const events = usePulseEvents(
    page.filters.workspaceId,
    page.selectedCell,
    dateKeys
  );

  // Adapters for updater-style callbacks expected by components
  const onEnabledMetricsChange = useCallback(
    (fn: (prev: string[]) => string[]) => {
      page.filterActions.setEnabledMetrics(fn(page.filters.enabledMetrics));
    },
    [page.filterActions, page.filters.enabledMetrics]
  );

  const onSetEventTypeFilter = useCallback(
    (fn: (p: { alert: boolean; log: boolean; task: boolean }) => { alert: boolean; log: boolean; task: boolean }) => {
      events.setFilters.setTypeFilter(fn(events.filters.typeFilter));
    },
    [events.setFilters, events.filters.typeFilter]
  );

  const onSetEventStatusFilter = useCallback(
    (fn: (p: { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => {
      events.setFilters.setStatusFilter(fn(events.filters.statusFilter));
    },
    [events.setFilters, events.filters.statusFilter]
  );

  const onSetEventsPanelStatus = useCallback(
    (fn: (p: { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => { open: boolean; ack: boolean; resolved: boolean; done: boolean }) => {
      events.setFilters.setStatus(fn(events.filters.status));
    },
    [events.setFilters, events.filters.status]
  );

  // Show placeholder while workspace not selected
  if (!workspaceId) {
    return (
      <AppShell>
        <div className="p-8 text-center text-muted-foreground">Выберите магазин</div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Рука на пульсе">
      <div className="space-y-4">
        {/* Per-stream sync freshness. Polls /wb/:ws/shops/:shop/sync-status
            once per minute (useShopSyncStatus). Колонки коррелируют с
            потоками данных Pulse: заказы и воронка. */}
        <div className="flex flex-wrap gap-2">
          <SyncFreshnessBadge stage="orders-sales" label="Заказы" />
          <SyncFreshnessBadge stage="funnel" label="Воронка" />
          <SyncFreshnessBadge stage="adv" label="Реклама" />
        </div>

        {/* Save Preset Modal */}
        <SavePresetModal
          open={page.presetModal.open}
          name={page.presetModal.name}
          description={page.presetModal.description}
          onNameChange={page.presetModal.setName}
          onDescriptionChange={page.presetModal.setDescription}
          onSave={page.presetModal.create}
          onClose={() => page.presetModal.setOpen(false)}
        />

        {/* Settings Sidebar */}
        <SettingsSidebar
          open={page.settingsOpen}
          onClose={() => page.setSettingsOpen(false)}
          workspaceId={page.filters.workspaceId}
          nmIds={page.filters.filterNmIds}
          onNmIdsChange={page.filterActions.setFilterNmIds}
          filterVendorCodes={page.filters.filterVendorCodes}
          filterBrandNames={page.filters.filterBrandNames}
          filterSubjectNames={page.filters.filterSubjectNames}
          onFilterVendorCodesChange={page.filterActions.setFilterVendorCodes}
          onFilterBrandNamesChange={page.filterActions.setFilterBrandNames}
          onFilterSubjectNamesChange={page.filterActions.setFilterSubjectNames}
          suggestBrands={page.suggestBrands}
          suggestVendorCodes={page.suggestVendorCodes}
          suggestSubjects={page.suggestSubjects}
          suggestNmIds={page.suggestNmIds}
          suggestBarcodes={page.suggestBarcodes}
          catalogGroups={page.catalogGroups}
          catalog={page.catalog}
          enabledMetrics={page.filters.enabledMetrics}
          onEnabledMetricsChange={onEnabledMetricsChange}
          overview={page.overview}
          drrBase={page.filters.drrBase}
          onDrrBaseChange={page.filterActions.setDrrBase}
          presets={page.presets}
          presetId={page.presetId}
          isDirty={page.isDirty}
          onSelectPreset={page.onSelectPreset}
          onSavePreset={page.onSavePreset}
          onSaveAsNewPreset={() => {
            page.presetModal.setName('');
            page.presetModal.setDescription('');
            page.presetModal.setOpen(true);
          }}
          onCreatePresetInline={(name: string) => page.createPresetDirect(name)}
          onDeletePreset={page.onDeletePreset}
        />

        {/* Quick Filter Bar */}
        <QuickFilterBar
          workspaceId={page.filters.workspaceId}
          onWorkspaceIdChange={page.filterActions.setWorkspaceId}
          tags={page.tags}
          tagId={page.filters.tagId}
          onTagIdChange={page.filterActions.setTagId}
          dateFrom={page.filters.dateFrom}
          dateTo={page.filters.dateTo}
          onDateFromChange={page.filterActions.setDateFrom}
          onDateToChange={page.filterActions.setDateTo}
          groupBy={page.filters.groupBy}
          onGroupByChange={page.filterActions.setGroupBy}
          anomalies={page.filters.anomalies}
          onAnomaliesChange={page.filterActions.setAnomalies}
          anomalyThresholdPct={page.filters.anomalyThresholdPct}
          onAnomalyThresholdPctChange={page.filterActions.setAnomalyThresholdPct}
          presets={page.presets}
          presetId={page.presetId}
          onSelectPreset={page.onSelectPreset}
          onDeletePreset={page.onDeletePreset}
          loading={page.loading}
          onRefresh={page.refresh}
          onOpenSettings={() => page.setSettingsOpen(true)}
        />

        {/* Error */}
        {page.error && (
          <div className="rounded-[var(--radius-lg)] border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {page.error}
          </div>
        )}

        {/* KPI Cards */}
        <PulseKPICards
          overview={page.overview}
          activeMetric={page.filters.productsMetric}
          onMetricChange={page.filterActions.setProductsMetric}
          showUnits={page.filters.tableShowUnits}
        />

        {/* Products filter toggle: С заказами / Все товары */}
        <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 p-0.5" style={{ width: 'fit-content' }}>
          <button
            onClick={() => page.filterActions.setIncludeAll(false)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              !page.filters.includeAll
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            С заказами{!page.filters.includeAll && page.productsMatrix?.totalCount != null ? ` (${page.productsMatrix.totalCount})` : ''}
          </button>
          <button
            onClick={() => page.filterActions.setIncludeAll(true)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              page.filters.includeAll
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Все товары{page.filters.includeAll && page.productsMatrix?.totalCount != null ? ` (${page.productsMatrix.totalCount})` : ''}
          </button>
        </div>

        {/* Compact Events Summary */}
        {events.timeline.length > 0 && (
          <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-2.5">
            <span className="text-xs font-medium text-[var(--content-muted)]">События:</span>
            {(() => {
              const alerts = events.timeline.filter((e: any) => e.type === 'alert').length;
              const tasks = events.timeline.filter((e: any) => e.type === 'task').length;
              const logs = events.timeline.filter((e: any) => e.type === 'log').length;
              return (
                <>
                  {alerts > 0 && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400">{alerts} алертов</span>}
                  {tasks > 0 && <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-400">{tasks} задач</span>}
                  {logs > 0 && <span className="rounded-full bg-gray-500/10 px-2 py-0.5 text-xs font-medium text-gray-500">{logs} событий</span>}
                </>
              );
            })()}
            <a href="/events" className="ml-auto text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors">
              Открыть в События →
            </a>
          </div>
        )}

        {/* WB Club Card */}
        {page.filters.workspaceId && page.filters.dateFrom && page.filters.dateTo && (
          <div className="mt-4">
            <WbClubCard
              workspaceId={page.filters.workspaceId}
              dateFrom={page.filters.dateFrom}
              dateTo={page.filters.dateTo}
            />
          </div>
        )}

        {/* Events Calendar (mini) — always visible when workspace loaded.
            By default shows workspace-wide events so users don't have to
            guess that clicking a cell reveals them. When a cell IS clicked,
            the calendar filters to that product's nm_id (with an "× все
            товары" reset chip in the header). AI actions are in the modal. */}
        {page.filters.workspaceId && (
          <div className="mt-4">
            <EventsCalendarMini
              workspaceId={page.filters.workspaceId}
              shopId={activeShopId}
              nmId={page.selectedCell?.nmId}
              selectedDate={page.selectedCell?.date}
              dateFrom={page.filters.dateFrom}
              dateTo={page.filters.dateTo}
              onClearNmFilter={page.selectedCell ? () => page.setSelectedCell(null) : undefined}
            />
          </div>
        )}

        {/* Heatmap Table */}
        <PulseHeatmapTable
          overview={page.overview}
          loading={page.loading}
          enabledMetrics={page.filters.enabledMetrics}
          groupBy={page.filters.groupBy}
          onGroupByChange={page.filterActions.setGroupBy}
          workspaceId={page.filters.workspaceId}
          dateFrom={page.filters.dateFrom}
          dateTo={page.filters.dateTo}
          enabledDrilldownMetrics={page.filters.enabledMetrics}
          tableView={page.filters.tableView}
          tableHeatmap={page.filters.tableHeatmap}
          tableHeatmapMode={page.filters.tableHeatmapMode}
          tableHeatmapIntensity={page.filters.tableHeatmapIntensity}
          tableHeatmapGlobal={page.tableHeatmapGlobal}
          tableNumberFormat={page.filters.tableNumberFormat}
          tableShowUnits={page.filters.tableShowUnits}
          tableDense={page.filters.tableDense}
          productsMetric={page.filters.productsMetric}
          anomalies={page.filters.anomalies}
          productsMatrix={page.productsMatrix}
          eventsNmId={page.eventsNmId}
          eventCountsByDate={events.eventCountsByDate}
          selectedCell={page.selectedCell}
          onSetTableView={page.filterActions.setTableView}
          onSetTableHeatmap={page.filterActions.setTableHeatmap}
          onSetTableHeatmapMode={page.filterActions.setTableHeatmapMode}
          onSetTableHeatmapIntensity={page.filterActions.setTableHeatmapIntensity}
          onSetTableNumberFormat={page.filterActions.setTableNumberFormat}
          onSetTableShowUnits={page.filterActions.setTableShowUnits}
          onSetTableDense={page.filterActions.setTableDense}
          onSetProductsMetric={page.filterActions.setProductsMetric as any}
          onSelectCell={(cell) => {
            page.setSelectedCell(cell);
            page.setEventsNmId(cell.nmId > 0 ? String(cell.nmId) : '');
          }}
          onLoadTimeline={events.loadTimeline}
          onHoverDate={async (date, x, y) => {
            const raw = Number.parseInt(page.eventsNmId.trim(), 10);
            const nmFilter = Number.isFinite(raw) && raw > 0 ? raw : null;
            await events.loadEventsForHover(date, nmFilter, x, y);
          }}
          onLeaveHover={() => events.setHoverTip(null)}
          onContextMenu={(date, x, y) => {
            const raw = Number.parseInt(page.eventsNmId.trim(), 10);
            const nmFilter = Number.isFinite(raw) && raw > 0 ? raw : 0;
            events.setContextMenu({ x, y, date, nmId: nmFilter });
          }}
        />

        {/* KPI-сводка + пагинатор (2026-06-01) */}
        {page.productsMatrix?.kpiTotal && (
          <div className="mt-3 rounded-xl border bg-white shadow-sm">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-100 rounded-t-xl overflow-hidden">
              <KpiCell label="Заказы" value={page.productsMatrix.kpiTotal.ordersCount} hint="штук за период" />
              <KpiCell label="Заказы ₽" value={page.productsMatrix.kpiTotal.ordersRub} hint="по WB Воронке (вкл. невыкупы)" rub />
              <KpiCell label="Выкупы" value={page.productsMatrix.kpiTotal.buyoutsCount} hint={`% выкупа: ${page.productsMatrix.kpiTotal.buyoutPct}%`} />
              <KpiCell label="Отмены" value={page.productsMatrix.kpiTotal.cancelsCount} hint={`${page.productsMatrix.kpiTotal.cancelPct}% от заказов`} />
            </div>
            <PaginatorBar
              totalCount={page.productsMatrix.totalCount ?? 0}
              offset={page.matrixPage.offset}
              limit={page.matrixPage.limit}
              onChange={page.setMatrixPage}
            />
          </div>
        )}

        {/* Overlays */}
        <ContextMenu
          menu={events.contextMenu}
          onAddEvent={(type, date, nmId) => {
            page.setSelectedCell({ date, nmId });
            events.setCreateModal.setType(type);
            events.setCreateModal.setDate(date);
            events.setCreateModal.setOpen(true);
          }}
          onClose={() => events.setContextMenu(null)}
        />

        <HoverTip
          tip={events.hoverTip}
          eventTypeFilter={events.filters.typeFilter}
          eventStatusFilter={events.filters.statusFilter}
        />

        <EventEditModal
          open={events.editModal.open}
          data={events.editModal.data}
          onChange={(update) => events.setEditModal.update(update)}
          onSave={events.setEditModal.save}
          onClose={events.setEditModal.close}
        />

        {page.selectedCell && (
          <EventCreateModal
            open={events.createModal.open}
            date={events.createModal.date || page.selectedCell.date || ''}
            type={events.createModal.type}
            time={events.createModal.time}
            category={events.createModal.category}
            severity={events.createModal.severity}
            dueAt={events.createModal.dueAt}
            title={events.createModal.title}
            description={events.createModal.description}
            onDateChange={events.setCreateModal.setDate}
            onTypeChange={events.setCreateModal.setType}
            onTimeChange={events.setCreateModal.setTime}
            onCategoryChange={events.setCreateModal.setCategory}
            onSeverityChange={events.setCreateModal.setSeverity}
            onDueAtChange={events.setCreateModal.setDueAt}
            onTitleChange={events.setCreateModal.setTitle}
            onDescriptionChange={events.setCreateModal.setDescription}
            onCreate={events.createEvent}
            onClose={() => events.setCreateModal.setOpen(false)}
          />
        )}

        {/* AI Analyze Button - fixed bottom right */}
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30">
          <AiAnalyzeButton
            context={{
              page: 'pulse',
              dateFrom: page.filters.dateFrom,
              dateTo: page.filters.dateTo,
              groupBy: page.filters.groupBy,
              tagId: page.filters.tagId,
            }}
            prompt="Проанализируй данные пульса"
          />
        </div>
      </div>
    </AppShell>
  );
}

/** KPI-плашка: число + подпись + опц. хинт. Используется в сводке над таблицей. */
function KpiCell({ label, value, hint, rub }: { label: string; value: number; hint?: string; rub?: boolean }) {
  const formatted = rub
    ? new Intl.NumberFormat('ru-RU').format(Math.round(value)) + ' ₽'
    : new Intl.NumberFormat('ru-RU').format(value);
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900 mt-0.5 tabular-nums">{formatted}</div>
      {hint && <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}

/** Простой пагинатор: «1 / 4 (← →)», 30 на странице. */
function PaginatorBar({ totalCount, offset, limit, onChange }: {
  totalCount: number;
  offset: number;
  limit: number;
  onChange: (next: { offset: number; limit: number }) => void;
}) {
  if (totalCount <= limit) {
    return (
      <div className="px-3 py-2 text-xs text-gray-500 border-t">
        Показано {totalCount} из {totalCount} товаров
      </div>
    );
  }
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(totalCount / limit);
  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = Math.min((totalPages - 1) * limit, offset + limit);
  return (
    <div className="px-3 py-2 flex items-center justify-between text-sm border-t bg-gray-50/50 rounded-b-xl">
      <div className="text-xs text-gray-500">
        Товары <span className="font-medium text-gray-700">{offset + 1}–{Math.min(offset + limit, totalCount)}</span> из {totalCount}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onChange({ offset: prevOffset, limit })}
          className="px-2 py-1 rounded border border-gray-200 text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white"
        >
          ← Назад
        </button>
        <span className="text-xs text-gray-600 tabular-nums">
          стр. {currentPage} / {totalPages}
        </span>
        <button
          type="button"
          disabled={offset + limit >= totalCount}
          onClick={() => onChange({ offset: nextOffset, limit })}
          className="px-2 py-1 rounded border border-gray-200 text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white"
        >
          Вперёд →
        </button>
      </div>
    </div>
  );
}
