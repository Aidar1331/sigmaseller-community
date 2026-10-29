import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BadRequestError, UnauthorizedError } from '../lib/errors.js';
import { checkAccess, hash, opaqueToken, SCOPES, transaction, type Database, type Identity, type Queryable, type Scope } from './access.js';

export const authorizationSchema = z.object({
  client_id: z.string().max(200), redirect_uri: z.string().url().max(2048), response_type: z.literal('code'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
  state: z.string().min(8).max(1024), resource: z.string().url(), scope: z.string().max(100).default('seller.read'),
});

export class SellerOAuth {
  constructor(readonly db: Database, readonly origin: string) {}
  get resource() { return `${this.origin}/mcp`; }
  metadata() {
    return { issuer: this.origin, authorization_endpoint: `${this.origin}/connections/authorize`,
      token_endpoint: `${this.origin}/oauth/token`, registration_endpoint: `${this.origin}/oauth/register`,
      revocation_endpoint: `${this.origin}/oauth/revoke`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES };
  }
  async register(input: unknown) {
    const body = z.object({ client_name: z.string().trim().min(1).max(80), redirect_uris: z.array(z.string().url().max(2048)).min(1).max(5),
      token_endpoint_auth_method: z.literal('none').default('none'),
      grant_types: z.array(z.enum(['authorization_code','refresh_token'])).optional(), response_types: z.array(z.literal('code')).optional(),
    }).parse(input);
    const hosts = (process.env.MCP_CLIENT_REDIRECT_HOSTS || 'chatgpt.com,claude.ai,claude.com').split(',').map(s => s.trim());
    for (const uri of body.redirect_uris) {
      const u = new URL(uri);
      const local = process.env.NODE_ENV !== 'production' && ['127.0.0.1','localhost'].includes(u.hostname);
      if (u.hash || u.username || u.password || (!local && (u.protocol !== 'https:' || u.port || !hosts.includes(u.hostname)))) {
        throw new BadRequestError('Адрес возврата приложения не разрешён');
      }
    }
    const clientId = randomUUID();
    await this.db.query('INSERT INTO seller_oauth_clients(client_id,client_name,redirect_uris) VALUES($1,$2,$3)',
      [clientId, body.client_name, JSON.stringify(body.redirect_uris)]);
    return { client_id: clientId, client_id_issued_at: Math.floor(Date.now()/1000), ...body,
      grant_types: ['authorization_code','refresh_token'], response_types: ['code'] };
  }
  async validateRequest(input: unknown) {
    const request = authorizationSchema.parse(input);
    const { rows } = await this.db.query('SELECT client_name,redirect_uris FROM seller_oauth_clients WHERE client_id=$1', [request.client_id]);
    if (!rows[0] || !rows[0].redirect_uris.includes(request.redirect_uri) || request.resource !== this.resource) {
      throw new BadRequestError('Некорректный запрос подключения');
    }
    const scopes = [...new Set(request.scope.split(' '))] as Scope[];
    if (!scopes.includes('seller.read') || scopes.some(s => !SCOPES.includes(s))) throw new BadRequestError('Некорректные разрешения');
    return { request, scopes, clientName: rows[0].client_name as string, redirectOrigin: new URL(request.redirect_uri).origin };
  }
  async authorize(userId: number, input: unknown, workspaceId: number, shopId: number, allow: boolean, selectedScopes?: Scope[]) {
    const { request, scopes:requestedScopes } = await this.validateRequest(input);
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', this.origin);
    if (!allow) { redirect.searchParams.set('error','access_denied'); return { redirect: redirect.href }; }
    const scopes=[...new Set(selectedScopes ?? requestedScopes)];
    if(!scopes.includes('seller.read') || scopes.some(s=>!requestedScopes.includes(s))) throw new BadRequestError('Нельзя расширить запрошенные разрешения');
    const who: Identity = { userId, workspaceId, shopId, scopes };
    for (const scope of scopes) await checkAccess(this.db, who, scope);
    const code = opaqueToken(), id = randomUUID();
    await transaction(this.db, async tx => {
      await tx.query(`INSERT INTO seller_oauth_grants(id,client_id,user_id,workspace_id,shop_id,scopes,resource) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, request.client_id, userId, workspaceId, shopId, scopes, this.resource]);
      await tx.query('INSERT INTO seller_oauth_codes(hash,grant_id,redirect_uri,challenge) VALUES($1,$2,$3,$4)', [hash(code), id, request.redirect_uri, request.code_challenge]);
    });
    redirect.searchParams.set('code', code);
    return { redirect: redirect.href };
  }
  private async issue(tx: Queryable, grant: any) {
    const access = opaqueToken(), refresh = opaqueToken();
    await tx.query(`INSERT INTO seller_oauth_tokens(hash,grant_id,kind,expires_at) VALUES
      ($1,$3,'access',LEAST(now()+interval '15 minutes',$4)),($2,$3,'refresh',$4)`, [hash(access), hash(refresh), grant.id, grant.expires_at]);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, scope: grant.scopes.join(' ') };
  }
  async token(input: unknown) {
    const body = z.object({ grant_type: z.enum(['authorization_code','refresh_token']), client_id: z.string().max(200), resource: z.string().url(),
      code: z.string().max(200).optional(), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(),
      redirect_uri: z.string().url().optional(), refresh_token: z.string().max(200).optional(), scope: z.string().optional(),
    }).parse(input);
    if (body.resource !== this.resource) throw new BadRequestError('invalid_target');
    const result = await transaction(this.db, async tx => {
      const codeMode = body.grant_type === 'authorization_code';
      // Table name is selected by this closed enum, never by an external string.
      const source = codeMode ? 'seller_oauth_codes' : 'seller_oauth_tokens';
      const secret = codeMode ? body.code : body.refresh_token;
      if (!secret) return null;
      const { rows } = await tx.query(`SELECT t.*,g.id,g.client_id,g.user_id,g.workspace_id,g.shop_id,g.scopes,
        g.resource,g.revoked_at,g.expires_at AS grant_expiry FROM ${source} t JOIN seller_oauth_grants g ON g.id=t.grant_id
        WHERE t.hash=$1 FOR UPDATE OF t,g`, [hash(secret)]);
      const row = rows[0];
      if (!row || row.client_id !== body.client_id || row.resource !== this.resource || (!codeMode && row.kind !== 'refresh')) return null;
      if (codeMode && (!body.code_verifier || row.redirect_uri !== body.redirect_uri ||
        row.challenge !== createHash('sha256').update(body.code_verifier).digest('base64url'))) return null;
      if (row.used_at) {
        // A spent refresh/code signals replay. Keep the tombstone and revoke its family.
        await tx.query('UPDATE seller_oauth_grants SET revoked_at=now() WHERE id=$1', [row.id]);
        return null;
      }
      if (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now() || new Date(row.grant_expiry).getTime() <= Date.now()) return null;
      if (body.scope && body.scope !== row.scopes.join(' ')) return null;
      const who = { userId: Number(row.user_id), workspaceId: Number(row.workspace_id), shopId: Number(row.shop_id), scopes: row.scopes };
      for (const s of row.scopes) await checkAccess(tx, who, s);
      await tx.query(`UPDATE ${source} SET used_at=now() WHERE hash=$1`, [hash(secret)]);
      return this.issue(tx, { ...row, expires_at: row.grant_expiry });
    });
    if (!result) throw new BadRequestError('invalid_grant');
    return result;
  }
  async authenticate(bearer: string | undefined): Promise<Identity> {
    const token = bearer?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    if (!token) throw new UnauthorizedError('invalid_token');
    const { rows } = await this.db.query(`SELECT g.* FROM seller_oauth_tokens t JOIN seller_oauth_grants g ON g.id=t.grant_id
      WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND g.expires_at>now() AND g.revoked_at IS NULL AND g.resource=$2`, [hash(token),this.resource]);
    const g = rows[0];
    if (!g) throw new UnauthorizedError('invalid_token');
    const who: Identity = { userId: Number(g.user_id), workspaceId: Number(g.workspace_id), shopId: Number(g.shop_id), scopes: g.scopes, grantId: g.id };
    await checkAccess(this.db, who);
    return who;
  }
  async revoke(input: unknown) {
    const body = z.object({ token: z.string().max(200), client_id: z.string().max(200) }).parse(input);
    await this.db.query(`UPDATE seller_oauth_grants SET revoked_at=now() WHERE client_id=$1 AND id IN
      (SELECT grant_id FROM seller_oauth_tokens WHERE hash=$2)`, [body.client_id,hash(body.token)]);
  }
}
