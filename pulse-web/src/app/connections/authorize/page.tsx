'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { box,button,connectionApi,ShopSelect,useConnections } from '@/components/connections/shared';

const labels:Record<string,string>={ 'seller.read':'Читать сохранённые продажи, товары, остатки, отзывы и рекламу', 'seller.drafts':'Сохранять текстовые черновики', 'seller.actions':'Готовить изменения для вашего отдельного подтверждения на сайте' };
type Details={ request:Record<string,string>;scopes:string[];clientName:string;redirectOrigin:string };
export default function AuthorizePage() {
  const { options,shop,selected,setSelected,error,setError }=useConnections();
  const [details,setDetails]=useState<Details|null>(null),[busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false);
  const [scopes,setScopes]=useState<string[]>(['seller.read']);
  useEffect(()=>{ let active=true; const request=Object.fromEntries(new URLSearchParams(window.location.search));
    connectionApi<Details>('/connections/authorize-details',{method:'POST',body:JSON.stringify(request)}).then(d=>{if(active)setDetails(d);}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[setError]);
  async function decide(allow:boolean) {
    if(!details || (allow && !shop))return; setBusy(true);setError('');
    try { const result=await connectionApi<{redirect:string}>('/connections/authorize',{method:'POST',body:JSON.stringify({request:details.request,...(shop?{workspaceId:Number(shop.workspace_id),shopId:Number(shop.shop_id)}:{}),allow,scopes})});
      window.location.assign(result.redirect);
    }catch(e){setError(e instanceof Error?e.message:'Не удалось подключить');setBusy(false);}
  }
  const enough=shop && (!scopes.includes('seller.actions') || shop.role==='owner') && (!scopes.includes('seller.drafts') || ['manager','supervisor','owner'].includes(shop.role));
  return <main className="mx-auto max-w-xl space-y-5 px-4 py-10 text-gray-900 dark:text-gray-100">
    <Link href="/connections" className="text-sm text-indigo-600">Sigma Seller · Подключения ИИ</Link>
    <h1 className="text-2xl font-semibold">Разрешить доступ к магазину</h1>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {details && <section className={box}>
      <h2 className="text-lg font-semibold break-words">{details.clientName}</h2>
      <p className="mt-2 text-sm break-all">Адрес приложения: {details.redirectOrigin}</p>
      <p className="mt-2 text-sm text-gray-500">Имя указано самим приложением. Разрешайте доступ только к подключению, которое вы сейчас добавляете в своём чате.</p>
      <p className="my-4 text-sm">По умолчанию — только чтение. Выберите дополнительные разрешения, если они нужны.</p>
      <p className="mb-3 text-sm">✓ {labels['seller.read']}</p>
      {details.scopes.filter(s=>s!=='seller.read').map(s=><label key={s} className="mb-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={scopes.includes(s)} onChange={e=>{setScopes(e.target.checked?[...scopes,s]:scopes.filter(v=>v!==s));setAccepted(false);}}/><span>{labels[s]}</span></label>)}
      {options && options.shops.length>0 ? <ShopSelect options={options} value={selected} onChange={v=>{setSelected(v);setAccepted(false);}}/> : <p>Сначала <Link href="/onboarding" className="text-indigo-600 underline">подключите магазин WB</Link>, затем повторите подключение из чата.</p>}
      {shop && !enough && <p className="mt-3 text-sm text-amber-800">Ваша роль не позволяет выдать все запрошенные разрешения. Для изменений нужен владелец; для черновиков — менеджер или выше.</p>}
      <label className="my-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} className="mt-1"/><span>Разрешаю передавать данные выбранного магазина этому приложению. Доступ можно отозвать в Sigma Seller. Изменения WB потребуют моего подтверждения на сайте.</span></label>
      <div className="flex flex-wrap gap-3"><button disabled={busy || !accepted || !enough} className={button} onClick={()=>void decide(true)}>Разрешить доступ</button><button disabled={busy} className="px-4 py-2 text-sm underline" onClick={()=>void decide(false)}>Отказать</button></div>
    </section>}
    {!details && !error && <p role="status">Проверяем запрос…</p>}
  </main>;
}
