import { writeFile } from 'node:fs/promises';
import { buildDailyMetrics } from './metricsByDate.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'metricsByDateScript' });

async function main() {
  const daysBack = Number.parseInt(process.env.DAYS_BACK || '14', 10);
  const metrics = await buildDailyMetrics(daysBack);

  const outPath = `${process.env.SPAWN_LOG_DIR ?? "out"}/wb-metrics-by-date-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(outPath, JSON.stringify({ daysBack, metrics }, null, 2), 'utf8');
  logger.info({ outPath }, 'Wrote output file');

}

main().catch((e) => {
  logger.error({ err: e }, 'metricsByDateScript failed');
  process.exitCode = 1;
});
