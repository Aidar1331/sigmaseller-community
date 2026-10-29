import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

export interface Queryable { query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> }
export interface Database extends Queryable { connect(): Promise<Queryable & { release(): void }> }
export type Scope = 'seller.read' | 'seller.drafts' | 'seller.actions';
export const SCOPES: Scope[] = ['seller.read', 'seller.drafts', 'seller.actions'];
export type Identity = { userId: number; workspaceId: number; shopId: number; scopes: Scope[]; grantId?: string };
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const rank: Record<string, number> = { viewer: 10, observer: 20, manager: 30, supervisor: 40, owner: 50 };
export const scopeRank: Record<Scope, number> = { 'seller.read': 10, 'seller.drafts': 30, 'seller.actions': 50 };

export async function checkAccess(db: Queryable, who: Identity, scope: Scope = 'seller.read'): Promise<string> {
  if (![who.userId, who.workspaceId, who.shopId].every(n => Number.isSafeInteger(n) && n > 0)) throw new ForbiddenError('Недоступный магазин');
  if (!who.scopes.includes(scope)) throw new ForbiddenError('Подключению не разрешена эта операция');
  const { rows } = await db.query(`SELECT m.role FROM workspace_members m
    JOIN marketplace_shops s ON s.workspace_id=m.workspace_id
    WHERE m.user_id=$1 AND m.workspace_id=$2 AND s.shop_id=$3 AND s.platform='wb' AND s.is_active=true`, [who.userId, who.workspaceId, who.shopId]);
  const role = rows[0]?.role;
  if ((rank[role] ?? 0) < scopeRank[scope]) throw new ForbiddenError('Недостаточно прав в выбранном магазине');
  if (who.grantId) {
    const g = await db.query(`SELECT 1 FROM seller_oauth_grants WHERE id=$1 AND user_id=$2 AND workspace_id=$3
      AND shop_id=$4 AND revoked_at IS NULL AND expires_at>now() AND $5=ANY(scopes)`,
    [who.grantId, who.userId, who.workspaceId, who.shopId, scope]);
    if (!g.rows.length) throw new UnauthorizedError('Подключение отозвано или истекло');
  }
  return role;
}

export async function audit(db: Queryable, who: Identity, operation: string, outcome: string, referenceId?: string) {
  await db.query(`INSERT INTO seller_ai_audit(user_id,workspace_id,shop_id,grant_id,operation,outcome,reference_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [who.userId, who.workspaceId, who.shopId, who.grantId ?? null, operation, outcome, referenceId ?? null]);
}

export async function transaction<T>(db: Database, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export function publicOrigin() {
  const url = new URL(process.env.MCP_PUBLIC_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
    (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost','127.0.0.1'].includes(url.hostname)))) {
    throw new Error('MCP_PUBLIC_ORIGIN must be the public HTTPS origin');
  }
  return url.origin;
}
