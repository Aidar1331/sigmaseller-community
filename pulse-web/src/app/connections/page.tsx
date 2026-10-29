'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { box,button,field,connectionApi,scopeQuery,ShopSelect,useConnections,type Shop } from '@/components/connections/shared';
type Grant={id:string;client_name:string;scopes:string[];expires_at:string;revoked_at:string|null};
type Proposal={id:string;payload:Record<string,unknown>;payload_hash:string;status:string;expires_at:string;result:{message?:string}|null};
type Data={grants:Grant[];drafts:{id:string;title:string;content:string}[];proposals:Proposal[];audit:{operation:string;outcome:string;created_at:string}[];role:string};
const kinds:Record<string,string>={feedback_reply:'Ответ на отзыв',question_reply:'Ответ на вопрос',price_change:'Изменение цены',card_description:'Описание карточки',campaign_pause:'Остановка рекламы'};
const statuses:Record<string,string>={pending:'Ожидает подтверждения',executing:'Результат ещё не подтверждён. Проверьте WB; повтор заблокирован.',accepted:'Запрос принят WB',rejected:'Запрос отклонён',unknown:'Результат неизвестен — проверьте кабинет WB',cancelled:'Отменено'};
const labels:Record<string,string>={nmId:'Артикул WB',itemId:'Номер отзыва / вопроса',campaignId:'Кампания',priceRub:'Цена до скидки, ₽',discountPercent:'Скидка продавца, %',text:'Текст ответа',description:'Новое описание',expectedDescription:'Описание до изменения'};
function ShopConnections({shop,writesEnabled}:{shop:Shop;writesEnabled:boolean}) {
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[checked,setChecked]=useState<Record<string,boolean>>({});
  const query=scopeQuery(shop);
  const reload=()=>connectionApi<Data>(`/connections/data?${query}`).then(setData);
  useEffect(()=>{let active=true;connectionApi<Data>(`/connections/data?${query}`).then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[query]);
  async function action(path:string,method:string,body?:unknown) {
    setBusy(path);setError('');setNotice('');
    try {const result=await connectionApi<{message?:string}>(`${path}?${query}`,{method,...(body?{body:JSON.stringify(body)}:{})});setNotice(result.message||'Готово');await reload();}
    catch(e){setError(e instanceof Error?e.message:'Не удалось выполнить');}finally{setBusy('');}
  }
  return <>
    {error&&<p role="alert" className="text-red-700">{error}</p>}{notice&&<p role="status" className="text-green-700">{notice}</p>}
    <section className={box}><h2 className="text-lg font-semibold">Подключённые приложения</h2>
      {data?.grants.length===0&&<p className="mt-3 text-sm text-gray-500">Пока нет подключений для этого магазина.</p>}
      {data?.grants.map(g=><div key={g.id} className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3"><div><p className="font-medium">{g.client_name}</p><p className="text-xs text-gray-500">{g.revoked_at?'Доступ отозван':`До ${new Date(g.expires_at).toLocaleDateString('ru-RU')}`} · {g.scopes.includes('seller.actions')?'Чтение, черновики и предложения':g.scopes.includes('seller.drafts')?'Чтение и черновики':'Только чтение'}</p></div>{!g.revoked_at&&<button className="text-sm text-red-700 underline disabled:opacity-40" disabled={!!busy} onClick={()=>void action(`/connections/grants/${g.id}`,'DELETE')}>Отозвать доступ</button>}</div>)}
    </section>
    <section className={box}><h2 className="text-lg font-semibold">Предложения изменений</h2><p className="mt-2 text-sm text-gray-500">Проверьте магазин и каждый параметр. Подтверждение действительно 15 минут и выполняется один раз.</p>
      {!writesEnabled&&<p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">Отправка в WB выключена до проверки условий API. Читать данные и сохранять черновики можно.</p>}
      {data?.proposals.length===0&&<p className="mt-3 text-sm text-gray-500">Здесь появятся предложения из чата.</p>}
      {data?.proposals.map(p=>{const expired=new Date(p.expires_at).getTime()<=Date.now();return <article id={p.id} key={p.id} className="mt-5 rounded-xl border border-gray-200 p-4 dark:border-neutral-700">
        <h3 className="font-semibold">{kinds[String(p.payload.kind)]||'Изменение'} · {shop.name}</h3>
        <dl className="mt-3 space-y-3 text-sm">{Object.entries(p.payload).filter(([k])=>k!=='kind').map(([k,v])=><div key={k}><dt className="text-gray-500">{labels[k]||k}</dt><dd className="whitespace-pre-wrap break-words">{String(v)}</dd></div>)}</dl>
        {p.payload.kind==='price_change'&&<p className="mt-3 text-sm font-medium">После скидки продавца: {(Number(p.payload.priceRub)*(1-Number(p.payload.discountPercent)/100)).toLocaleString('ru-RU')} ₽. Скидки WB могут отличаться.</p>}
        <p className="mt-3 text-sm">{expired&&p.status==='pending'?'Срок подтверждения истёк':statuses[p.status]||p.status}</p>{p.result?.message&&<p className="mt-2 text-sm">{p.result.message}</p>}
        {p.status==='pending'&&!expired&&<><label className="my-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!checked[p.id]} onChange={e=>setChecked({...checked,[p.id]:e.target.checked})}/><span>Проверил параметры и разрешаю отправить это изменение в магазин «{shop.name}».</span></label><div className="flex flex-wrap gap-3"><button className={button} disabled={!!busy||!checked[p.id]||!writesEnabled||data.role!=='owner'} onClick={()=>void action(`/connections/proposals/${p.id}/confirm`,'POST',{payloadHash:p.payload_hash,confirm:true})}>Подтвердить и отправить</button><button className="px-3 py-2 text-sm underline" disabled={!!busy} onClick={()=>void action(`/connections/proposals/${p.id}/cancel`,'POST')}>Отменить</button></div></>}
      </article>;})}
    </section>
    <section className={box}><h2 className="text-lg font-semibold">Мои черновики</h2>{data?.drafts.length===0&&<p className="mt-3 text-sm text-gray-500">Попросите чат сохранить текст в Sigma Seller.</p>}{data?.drafts.map(d=><article key={d.id} className="mt-4 border-t pt-4"><h3 className="font-medium">{d.title}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{d.content}</p></article>)}</section>
    <details className={box}><summary className="cursor-pointer font-semibold">Журнал последних операций</summary><ul className="mt-4 space-y-2 text-xs">{data?.audit.map((a,i)=><li key={i} className="break-words">{new Date(a.created_at).toLocaleString('ru-RU')} · {a.operation} · {a.outcome}</li>)}</ul></details>
  </>;
}
export default function ConnectionsPage() {
  const {options,shop,selected,setSelected,error}=useConnections();const [copied,setCopied]=useState(false);
  return <AppShell><main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Подключения ИИ</h1><Link href="/assistant" className="text-sm text-indigo-600 underline">Чат внутри Sigma Seller</Link></div>
    <p className="text-gray-600 dark:text-gray-400">Общайтесь о магазине в своём ChatGPT или Claude. Анализ выполняется в вашем ИИ-аккаунте по его тарифу и лимитам; Sigma Seller предоставляет данные и сохраняет черновики.</p>
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {options&&<>
      <section className={box}><h2 className="text-lg font-semibold">Добавить Sigma Seller в свой чат</h2><ol className="my-4 list-decimal space-y-2 pl-5 text-sm"><li>В ChatGPT откройте настройки приложений / плагинов и добавление своего MCP-сервера. В Claude — настройки подключений и добавление своего сервера.</li><li>Вставьте адрес ниже и выберите авторизацию OAuth, если это поле предлагается.</li><li>Войдите в Sigma Seller, выберите магазин и подтвердите разрешения.</li></ol>
        <label className="block text-sm">Адрес MCP-сервера<input aria-label="Адрес MCP-сервера" className={field} readOnly value={options.mcpUrl}/></label><button className="mt-3 text-sm text-indigo-600 underline" onClick={()=>{void navigator.clipboard.writeText(options.mcpUrl).then(()=>setCopied(true)).catch(()=>setCopied(false));}}>{copied?'Адрес скопирован':'Скопировать адрес'}</button>
        <p className="mt-3 text-xs text-gray-500">Доступность своих подключений зависит от аккаунта и настроек ИИ-провайдера. Если поля нет, проверьте его справку или разрешения организации.</p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-indigo-600"><a href="https://developers.openai.com/api/docs/guides/custom-mcp-server" target="_blank" rel="noreferrer">Инструкция ChatGPT ↗</a><a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noreferrer">Инструкция Claude ↗</a></div>
      </section>
      <section className={box}><h2 className="font-semibold">Подписка в чате на нашем сайте</h2><p className="mt-2 text-sm">{options.subscription.reason}</p><Link href="/settings/ai" className="mt-3 inline-block text-sm text-indigo-600 underline">Настроить свой API-ключ</Link></section>
      {options.shops.length>0?<ShopSelect options={options} value={selected} onChange={setSelected}/>:<p>Сначала <Link href="/onboarding" className="text-indigo-600 underline">подключите магазин</Link>.</p>}
      {shop&&<ShopConnections key={shop.shop_id} shop={shop} writesEnabled={options.wbWritesEnabled}/>}
    </>}
  </main></AppShell>;
}
