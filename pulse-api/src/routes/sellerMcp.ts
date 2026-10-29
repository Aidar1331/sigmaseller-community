import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/client.js';
import { AppError, ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { checkAccess, publicOrigin, SCOPES, type Identity } from '../mcp/access.js';
import { SellerOAuth } from '../mcp/oauth.js';
import { SellerTools } from '../mcp/tools.js';
import { handleSellerMcp } from '../mcp/server.js';
import { sellerChat } from '../mcp/chat.js';
import { executeWbAction, wbWritesEnabled } from '../mcp/wbExecutor.js';

const scopeSchema = z.object({ workspaceId:z.coerce.number().int().positive(),shopId:z.coerce.number().int().positive() });
function sessionUser(req: FastifyRequest) {
  // These controls require the actual browser session, never API-key impersonation.
  if (!req.user || !req.cookies?.session || req.headers['x-api-key']) throw new UnauthorizedError('Войдите в Sigma Seller');
  return req.user.userId;
}
function browserIdentity(req: FastifyRequest): Identity {
  const scope = scopeSchema.parse(req.query);
  return { userId:sessionUser(req),...scope,scopes:[...SCOPES] };
}

export const sellerMcpRoutes: FastifyPluginAsync = async app => {
  const origin = publicOrigin(), oauth = new SellerOAuth(pool,origin);
  const service = new SellerTools(pool,origin,executeWbAction,wbWritesEnabled());
  app.addHook('onRequest',async (_req,reply)=>{ reply.header('Cache-Control','no-store'); reply.header('Referrer-Policy','no-referrer'); });
  app.addContentTypeParser('application/x-www-form-urlencoded',{ parseAs:'string',bodyLimit:16384 },(_req,body,done)=>{
    const params = new URLSearchParams(body as string);
    if (new Set(params.keys()).size !== [...params.keys()].length) return done(new Error('Duplicate parameters'));
    done(null,Object.fromEntries(params));
  });
  app.get('/.well-known/oauth-authorization-server',async()=>oauth.metadata());
  const resourceMetadata = async()=>({ resource:oauth.resource,authorization_servers:[origin],scopes_supported:SCOPES,bearer_methods_supported:['header'],resource_name:'Sigma Seller' });
  app.get('/.well-known/oauth-protected-resource',resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp',resourceMetadata);
  app.post('/oauth/register',{ bodyLimit:16384,config:{ rateLimit:{ max:5,timeWindow:'1 hour' } } },async(req,reply)=>reply.code(201).send(await oauth.register(req.body)));
  app.post('/oauth/token',{ bodyLimit:16384,config:{ rateLimit:{ max:30,timeWindow:'1 minute' } } },async(req,reply)=>{
    try { return await oauth.token(req.body); }
    catch (e) { return reply.code(400).send({ error:e instanceof AppError && e.message === 'invalid_target' ? 'invalid_target' : 'invalid_grant' }); }
  });
  app.post('/oauth/revoke',{ bodyLimit:4096 },async(req,reply)=>{ await oauth.revoke(req.body); return reply.code(200).send({}); });
  app.route({ method:['POST','GET','DELETE'],url:'/mcp',bodyLimit:65536,config:{ rateLimit:{ max:120,timeWindow:'1 minute' } },handler:async(req,reply)=>{
    const allowed = [origin,'https://chatgpt.com','https://claude.ai','https://claude.com'];
    if (req.headers.origin && !allowed.includes(req.headers.origin)) throw new ForbiddenError('Origin не разрешён');
    let who: Identity;
    try { who = await oauth.authenticate(req.headers.authorization); }
    catch { return reply.code(401).header('WWW-Authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`).send({ error:'invalid_token' }); }
    if (req.method !== 'POST') return reply.code(405).header('Allow','POST').send({ error:'Stateless endpoint; use POST' });
    const headers = new Headers();
    for (const name of ['content-type','accept','mcp-protocol-version','mcp-session-id','mcp-method','mcp-name']) {
      const v = req.headers[name]; if (typeof v === 'string') headers.set(name,v);
    }
    const result = await handleSellerMcp(new Request(oauth.resource,{ method:'POST',headers,body:JSON.stringify(req.body) }),who,service);
    result.headers.forEach((v,k)=>reply.header(k,v));
    return reply.code(result.status).send(Buffer.from(await result.arrayBuffer()));
  } });
  app.get('/connections/options',async req=>{
    const userId = sessionUser(req);
    const { rows } = await pool.query(`SELECT s.shop_id,s.workspace_id,s.name,m.role FROM marketplace_shops s
      JOIN workspace_members m ON m.workspace_id=s.workspace_id WHERE m.user_id=$1 AND s.platform='wb' AND s.is_active=true ORDER BY s.workspace_id,s.shop_id`,[userId]);
    return { shops:rows,mcpUrl:oauth.resource,wbWritesEnabled:service.writesEnabled,
      subscription:{ available:false,reason:'Для общего сайта нужен подтверждённый доступ к официальному Sign in with ChatGPT. Сейчас используйте внешний чат через MCP или свой API-ключ.',docsUrl:'https://developers.openai.com/siwc/token-sharing-open-source' } };
  });
  app.post('/connections/authorize-details',{ bodyLimit:8192 },async req=>{ sessionUser(req); return oauth.validateRequest(req.body); });
  app.post('/connections/authorize',{ bodyLimit:16384 },async req=>{
    const body = z.discriminatedUnion('allow',[
      z.object({ request:z.unknown(),workspaceId:z.number().int().positive(),shopId:z.number().int().positive(),allow:z.literal(true),scopes:z.array(z.enum(['seller.read','seller.drafts','seller.actions'])).max(3).optional() }).strict(),
      z.object({ request:z.unknown(),workspaceId:z.number().int().positive().optional(),shopId:z.number().int().positive().optional(),allow:z.literal(false),scopes:z.array(z.enum(['seller.read','seller.drafts','seller.actions'])).max(3).optional() }).strict(),
    ]).parse(req.body);
    return oauth.authorize(sessionUser(req),body.request,body.workspaceId ?? 0,body.shopId ?? 0,body.allow,body.scopes);
  });
  app.get('/connections/data',async req=>{
    const who = browserIdentity(req); const role = await checkAccess(pool,who);
    const params = [who.userId,who.workspaceId,who.shopId];
    const grants = await pool.query(`SELECT g.id,c.client_name,g.scopes,g.created_at,g.expires_at,g.revoked_at FROM seller_oauth_grants g
      JOIN seller_oauth_clients c ON c.client_id=g.client_id WHERE g.user_id=$1 AND g.workspace_id=$2 AND g.shop_id=$3 ORDER BY g.created_at DESC LIMIT 50`,params);
    const drafts = await pool.query('SELECT id,title,content,created_at FROM seller_ai_drafts WHERE user_id=$1 AND workspace_id=$2 AND shop_id=$3 ORDER BY created_at DESC LIMIT 30',params);
    const proposals = await pool.query('SELECT id,payload,payload_hash,status,expires_at,result FROM seller_ai_proposals WHERE user_id=$1 AND workspace_id=$2 AND shop_id=$3 ORDER BY created_at DESC LIMIT 30',params);
    const audit = await pool.query('SELECT operation,outcome,reference_id,created_at FROM seller_ai_audit WHERE user_id=$1 AND workspace_id=$2 AND shop_id=$3 ORDER BY id DESC LIMIT 50',params);
    return { grants:grants.rows,drafts:drafts.rows,proposals:proposals.rows,audit:audit.rows,role };
  });
  app.delete('/connections/grants/:id',async req=>{
    const who = browserIdentity(req); await checkAccess(pool,who);
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params);
    await pool.query('UPDATE seller_oauth_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND shop_id=$4',[id,who.userId,who.workspaceId,who.shopId]);
    return { ok:true };
  });
  app.post('/connections/proposals/:id/confirm',async req=>{
    const who = browserIdentity(req);
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params);
    const { payloadHash } = z.object({ payloadHash:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true) }).strict().parse(req.body);
    return service.confirm(who,id,payloadHash);
  });
  app.post('/connections/proposals/:id/cancel',async req=>{
    const who = browserIdentity(req); await checkAccess(pool,who);
    const { id } = z.object({ id:z.string().uuid() }).parse(req.params);
    await pool.query(`UPDATE seller_ai_proposals SET status='cancelled' WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND shop_id=$4 AND status='pending'`,[id,who.userId,who.workspaceId,who.shopId]);
    return { ok:true };
  });
  app.post('/connections/chat',{ bodyLimit:50000,config:{ rateLimit:{ max:10,timeWindow:'1 minute' } } },async req=>sellerChat(service,browserIdentity(req),req.body));
};
