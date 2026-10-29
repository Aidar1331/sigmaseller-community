'use client';
import { useEffect,useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useWorkspaceStore } from '@/store/workspace';
export type Shop={ shop_id:string; workspace_id:string; name:string; role:string };
export type Options={ shops:Shop[]; mcpUrl:string; wbWritesEnabled:boolean; subscription:{ available:boolean; reason:string; docsUrl:string } };
export const box='rounded-2xl border border-gray-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900';
export const button='rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40';
export const field='mt-1 block w-full min-w-0 rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-base';
export const connectionApi=<T,>(path:string,init:RequestInit={})=>apiFetch<T>(path,{ ...init,skipWorkspaceId:true,skipShopId:true });
export const scopeQuery=(shop:Shop)=>`workspaceId=${shop.workspace_id}&shopId=${shop.shop_id}`;
export function useConnections() {
  const [options,setOptions]=useState<Options|null>(null),[error,setError]=useState('');
  const selected=String(useWorkspaceStore(s=>s.shopId) ?? '');
  const choose=(shop:Shop)=>useWorkspaceStore.getState().setWorkspaceAndShop(Number(shop.workspace_id),Number(shop.shop_id),shop.name);
  const setSelected=(id:string)=>{const shop=options?.shops.find(s=>String(s.shop_id)===id);if(shop)choose(shop);};
  useEffect(()=>{ let active=true; connectionApi<Options>('/connections/options').then(value=>{
    if (!active) return; setOptions(value);
    const requested=new URLSearchParams(window.location.search).get('shopId');
    const current=String(useWorkspaceStore.getState().shopId ?? '');
    const chosen=value.shops.find(s=>String(s.shop_id)===(requested||current)) ?? value.shops[0];
    if(chosen)choose(chosen);
  }).catch(e=>{ if(active)setError(e.message); }); return()=>{active=false;}; },[]);
  return { options,shop:options?.shops.find(s=>String(s.shop_id)===String(selected)),selected,setSelected,error,setError };
}
export function ShopSelect({ options,value,onChange }:{ options:Options;value:string;onChange:(s:string)=>void }) {
  return <label className="block text-sm font-medium">Магазин<select aria-label="Магазин" className={field} value={value} onChange={e=>onChange(e.target.value)}>
    {options.shops.map(s=><option key={s.shop_id} value={s.shop_id}>{s.name} · №{s.shop_id}</option>)}
  </select></label>;
}
