import { OwnerOnlyGate } from '@/components/OwnerOnlyGate';

// /bidder работает технически (activeHours[] фильтрует, budget alerts), но
// требует ручной настройки правил — это не plug-and-play для нового пользователя.
// До готовности шаблонов / автонастройки — показывается только владельцу.
export default function BidderLayout({ children }: { children: React.ReactNode }) {
  return (
    <OwnerOnlyGate
      title="Рекламный биддер"
      etaNote="Готовим набор готовых правил «из коробки» и шаблоны под популярные стратегии — чтобы запускать биддер без ручной настройки."
    >
      {children}
    </OwnerOnlyGate>
  );
}
