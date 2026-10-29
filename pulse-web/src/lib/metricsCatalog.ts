import { apiFetch } from './api';

export type MetricGroup = {
  groupId: string;
  title: string;
  sortOrder: number;
};

export type Metric = {
  metricId: string;
  groupId: string;
  title: string;
  unit: string | null;
  sortOrder: number;
  isDefaultEnabled: boolean;
};

export async function fetchMetricsCatalog(): Promise<{ groups: MetricGroup[]; metrics: Metric[] }> {
  return apiFetch('/metrics/catalog');
}
