import type { NextRequest } from 'next/server';
import { mcpProxy } from '@/lib/mcpProxy';
export const dynamic='force-dynamic';
export const GET=(req:NextRequest)=>mcpProxy(req,'/.well-known/oauth-authorization-server');
