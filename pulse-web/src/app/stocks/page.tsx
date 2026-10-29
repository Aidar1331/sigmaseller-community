import { redirect } from 'next/navigation';

// Stocks is handled via /analytics/warehouses
export default function StocksPage() {
  redirect('/analytics/warehouses');
}
