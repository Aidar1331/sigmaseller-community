import { useQuery } from '@tanstack/react-query';
import { fetchMetricsCatalog, type MetricGroup, type Metric } from '@/lib/metricsCatalog';

export type { MetricGroup, Metric };

export function useMetricsCatalog() {
  return useQuery({
    queryKey: ['metricsCatalog'],
    queryFn: fetchMetricsCatalog,
    staleTime: 5 * 60_000, // catalog rarely changes — cache 5 min
  });
}
