import { OwnerOnlyGate } from '@/components/OwnerOnlyGate';

// /seo требует подписку «Джем» в WB Analytics. У большинства пользователей
// она не оплачена → таблица search_queries приходит пустой. Поэтому страница
// показывается только владельцу (id=1) до полноценной готовности.
export default function SeoLayout({ children }: { children: React.ReactNode }) {
  return (
    <OwnerOnlyGate
      title="SEO позиции"
      etaNote="Нужна подписка «Джем» в WB Analytics — без неё отчёты по поисковым запросам не отдаются. Дорабатываем альтернативный источник данных."
    >
      {children}
    </OwnerOnlyGate>
  );
}
