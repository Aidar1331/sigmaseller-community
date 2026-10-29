import 'dotenv/config';
import { eq, and, gte, lte, desc, asc, or, sql, inArray } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { wbCards, wbCogs } from '../../db/schema.js';
import log from '../../lib/logger.js';

const logger = log.child({ module: 'cogsImport' });

// Minimal XLSX parser without heavy deps: use Python (openpyxl) to extract as TSV.

async function main() {
  const workspaceIdStr = process.env.WORKSPACE_ID;
  if (!workspaceIdStr) {
    throw new Error('WORKSPACE_ID environment variable is required');
  }
  const workspaceId = Number.parseInt(workspaceIdStr, 10);
  if (isNaN(workspaceId) || workspaceId <= 0) {
    throw new Error(`Invalid WORKSPACE_ID: ${workspaceIdStr}`);
  }
  const xlsxPath = process.env.XLSX_PATH;
  if (!xlsxPath) throw new Error('XLSX_PATH is required');

  // Use venv python to extract needed columns into JSON (vendorCode -> cogsRub)
  const { spawnSync } = await import('node:child_process');

  const py = process.env.PYTHON_BIN || '/root/clawd/.venv/bin/python';
  const code = `
import json, sys
import openpyxl
path=sys.argv[1]
wb=openpyxl.load_workbook(path, data_only=True)
ws=wb[wb.sheetnames[0]]
rows=[]
for i,r in enumerate(ws.iter_rows(values_only=True)):
    if i==0: continue
    name, vc, vc2, cogs = (list(r)+[None,None,None,None])[:4]
    if vc is None and vc2 is None: continue
    v=str(vc or vc2).strip()
    if not v: continue
    try:
        c=float(cogs)
    except:
        continue
    rows.append({'vendorCode': v, 'cogsRub': c})
print(json.dumps(rows, ensure_ascii=False))
`;

  const p = spawnSync(py, ['-c', code, xlsxPath], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(p.stderr || 'python failed');

  const parsed = JSON.parse(p.stdout) as Array<{ vendorCode: string; cogsRub: number }>;
  const byVendor = new Map<string, number>();
  for (const r of parsed) {
    if (!r.vendorCode) continue;
    byVendor.set(r.vendorCode, r.cogsRub);
  }

  const vendorCodes = [...byVendor.keys()];
  if (!vendorCodes.length) {
    logger.info('No rows in file');
    return;
  }

  const cards = await db
    .select({ nmId: wbCards.nmId, vendorCode: wbCards.vendorCode })
    .from(wbCards)
    .where(and(eq(wbCards.workspaceId, workspaceId), inArray(wbCards.vendorCode, vendorCodes)));

  const nmByVendor = new Map(cards.filter((c) => c.vendorCode).map((c) => [c.vendorCode!, c.nmId] as const));

  let matched = 0;
  let missing = 0;

  for (const [vendorCode, cogsRub] of byVendor.entries()) {
    const nmId = nmByVendor.get(vendorCode);
    if (!nmId) {
      missing++;
      continue;
    }
    matched++;
    const cogsKopecks = Math.round(cogsRub * 100);
    await db
      .insert(wbCogs)
      .values({ workspaceId, nmId, cogsKopecks, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [wbCogs.workspaceId, wbCogs.nmId],
        set: { cogsKopecks, updatedAt: new Date() },
      });
  }

  logger.info({ workspaceId, rowsInFile: byVendor.size, matched, missing }, 'Import complete');
}

main().catch((e) => {
  logger.error({ err: e }, 'cogsImport failed');
  process.exit(1);
});
