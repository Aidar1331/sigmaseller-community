/* ── Re-export all hooks for convenient imports ── */

export { useSyncStatus } from './useSyncStatus';
export { useMetricsCatalog } from './useMetricsCatalog';
export {
  usePresets,
  useCreatePreset,
  useUpdatePreset,
  useDuplicatePreset,
  useDeletePreset,
  useRestorePreset,
} from './usePresets';
export { usePulseOverview } from './usePulseOverview';
export { useProductsMatrix } from './useProductsMatrix';
export { useTags, useProductTags, useAssignTag, useRemoveTag } from './useTags';
export {
  useEventCounts,
  useEventsForCell,
  useEventComments,
  useAddEventComment,
  useCreateEvent,
  useUpdateEvent,
} from './useEvents';
export { usePlanSummary } from './usePlanSummary';
export { useAlertsReport, useRunAutoAlerts } from './useAlerts';
export { useDebounce } from './useDebounce';
export { useAiChat } from './useAiChat';
export { useAIGeneration, calculateCost, CREDIT_COSTS, type GenerateOptions, type RemoveBgOptions, type TaskResult } from './useAIGeneration';

// Composite hooks for Pulse page
export { usePulseFilters, type PulseFiltersState, type PulseFiltersActions, type UsePulseFiltersResult } from './usePulseFilters';
export { usePulsePage, type SelectedCell, type UsePulsePageResult } from './usePulsePage';
export { usePulseEvents, type EventFilters, type EventModalState, type EventEditState, type UsePulseEventsResult } from './usePulseEvents';
