import type { NextRequest } from 'next/server';
import { mcpProxy } from '@/lib/mcpProxy';
export const dynamic='force-dynamic';
export const POST=(req:NextRequest)=>mcpProxy(req,'/mcp');
export const GET=POST;
export const DELETE=POST;
