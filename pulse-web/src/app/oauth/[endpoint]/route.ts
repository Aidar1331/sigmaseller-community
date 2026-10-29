import type { NextRequest } from 'next/server';
import { mcpProxy } from '@/lib/mcpProxy';
export const dynamic='force-dynamic';
export async function POST(req:NextRequest,{ params }:{ params:Promise<{ endpoint:string }> }) {
  const { endpoint }=await params;
  if (!['register','token','revoke'].includes(endpoint)) return new Response(null,{ status:404 });
  return mcpProxy(req,`/oauth/${endpoint}`);
}
