import type { NextRequest } from 'next/server';

/** Public protocol proxy: never forwards browser cookies, internal keys or impersonation. */
export async function mcpProxy(req: NextRequest, path: string) {
  const headers = new Headers();
  for (const name of ['content-type','accept','authorization','mcp-protocol-version','mcp-session-id','mcp-method','mcp-name','origin']) {
    const value = req.headers.get(name); if (value) headers.set(name,value);
  }
  let body: Uint8Array | undefined;
  if (req.body && !['GET','HEAD'].includes(req.method)) {
    const reader = req.body.getReader(), chunks:Uint8Array[] = []; let size=0;
    while (true) {
      const { done,value } = await reader.read(); if (done) break;
      size += value.length;
      if (size>65536) { await reader.cancel(); return Response.json({ error:'Request too large' },{ status:413 }); }
      chunks.push(value);
    }
    body = new Uint8Array(size); let offset=0;
    for (const chunk of chunks) { body.set(chunk,offset); offset+=chunk.length; }
  }
  try {
    const response = await fetch(new URL(path,process.env.PULSE_API_BASE || 'http://127.0.0.1:3002'),{
      method:req.method,headers,body:body as BodyInit | undefined,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000),
    });
    const output = new Headers({ 'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff' });
    for (const name of ['content-type','www-authenticate','allow','retry-after','mcp-session-id','mcp-protocol-version']) {
      const value=response.headers.get(name); if (value) output.set(name,value);
    }
    return new Response(response.body,{ status:response.status,headers:output });
  } catch { return Response.json({ error:'Service unavailable' },{ status:502,headers:{ 'Cache-Control':'no-store' } }); }
}
