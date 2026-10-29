'use client';
import { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { box,button,field,connectionApi,scopeQuery,ShopSelect,useConnections,type Shop } from '@/components/connections/shared';
type Message={role:'user'|'assistant';content:string};
function Chat({shop}:{shop:Shop}) {
  const [provider,setProvider]=useState('openai'),[model,setModel]=useState('gpt-4.1-mini'),[accepted,setAccepted]=useState(false);
  const [messages,setMessages]=useState<Message[]>([]),[input,setInput]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function send() {
    if(!input.trim()||busy)return;
    const next:Message[]=[...messages,{role:'user',content:input.trim()}];
    setBusy(true);setError('');
    try {const result=await connectionApi<{text:string;toolsUsed:string[]}>(`/connections/chat?${scopeQuery(shop)}`,{method:'POST',body:JSON.stringify({provider,model,acceptProviderCharges:accepted,messages:next.slice(-19)})});
      setMessages([...next,{role:'assistant',content:result.text}]);setInput('');
    }catch(e){setError(e instanceof Error?e.message:'Не удалось получить ответ');}finally{setBusy(false);}
  }
  const allowed=['owner','supervisor','manager'].includes(shop.role);
  return <section className={box}>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Источник ИИ<select className={field} disabled={busy} value={provider} onChange={e=>{setProvider(e.target.value);setModel(e.target.value==='openai'?'gpt-4.1-mini':'claude-sonnet-4-6');setAccepted(false);}}><option value="openai">Мой ключ OpenAI</option><option value="anthropic">Мой ключ Anthropic</option></select></label><label className="text-sm">Модель<input className={field} disabled={busy} value={model} maxLength={100} onChange={e=>setModel(e.target.value)} /></label></div>
    <label className="my-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={busy} checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>Использовать ключ выбранного магазина. Провайдер может списывать оплату за сообщения и обращения к инструментам. Лимит расходов устанавливается в его кабинете.</span></label>
    {!allowed&&<p className="my-3 text-sm text-amber-800">Для использования ключа команды нужна роль менеджера или выше.</p>}
    <div className="min-h-40 space-y-4 py-4" aria-live="polite">
      {messages.length===0&&<div className="text-sm text-gray-500"><p>Начните с вопроса о данных магазина:</p><button className="mt-3 rounded-xl bg-gray-100 p-3 text-left text-gray-800" onClick={()=>setInput('Какие данные о моём магазине сохранены и насколько они свежие?')}>Какие данные доступны и когда обновлялись?</button></div>}
      {messages.map((m,i)=><article key={i} className={`rounded-xl p-4 ${m.role==='user'?'bg-indigo-50 text-indigo-950':'bg-gray-50 text-gray-900 dark:bg-neutral-800 dark:text-gray-100'}`}><p className="mb-2 text-xs font-semibold">{m.role==='user'?'Вы':'Помощник'}</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{m.content}</p></article>)}
      {busy&&<p role="status" className="text-sm text-gray-500">Смотрим данные магазина…</p>}
    </div>
    {error&&<p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
    <form onSubmit={e=>{e.preventDefault();void send();}}><label className="text-sm">Ваш вопрос<textarea className={`${field} min-h-24`} value={input} maxLength={8000} disabled={busy} onChange={e=>setInput(e.target.value)} /></label><div className="mt-3 flex flex-wrap items-center gap-3"><button className={button} disabled={busy||!input.trim()||!accepted||!allowed}>Отправить</button><button type="button" className="text-sm underline" disabled={busy||!messages.length} onClick={()=>setMessages([])}>Новый разговор</button><Link href={`/connections?shopId=${shop.shop_id}`} className="ml-auto text-sm text-indigo-600 underline">Черновики и подтверждения</Link></div></form>
    <p className="mt-4 text-xs text-gray-500">История этого разговора хранится только в открытой странице. Чат читает сохранённые данные; наличие остатков и цен в WB проверяйте по времени обновления.</p>
  </section>;
}
export default function AssistantPage() {
  const {options,shop,selected,setSelected,error}=useConnections();
  return <AppShell><main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Чат с магазином</h1><Link href="/settings/ai" className="text-sm text-indigo-600 underline">Настроить ключ ИИ</Link></div><p className="text-sm text-gray-600 dark:text-gray-400">Анализируйте продажи, остатки, отзывы и рекламу. Для работы по подписке в своём ChatGPT или Claude используйте <Link href="/connections" className="text-indigo-600 underline">подключение Sigma Seller</Link>.</p>
    {error&&<p role="alert" className="text-red-700">{error}</p>}{options&&(options.shops.length?<ShopSelect options={options} value={selected} onChange={setSelected}/>:<p><Link href="/onboarding" className="text-indigo-600 underline">Подключите магазин WB</Link>, чтобы начать.</p>)}{shop&&<Chat key={shop.shop_id} shop={shop}/>}
  </main></AppShell>;
}
