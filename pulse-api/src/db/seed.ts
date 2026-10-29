import { db, pool } from './client.js';
import { eq, and, gte, lte, desc, asc, or, sql, inArray, isNull, isNotNull, ne, gt, lt } from 'drizzle-orm';
import { pulseMetricGroups, pulseMetricsCatalog, users, workspaces, workspaceMembers } from './schema.js';
import { hashPassword } from '../lib/password.js';

async function main() {
  // Minimal seed for local/dev.
  // In real prod we won't hardcode these.

  const [ws] = await db
    .insert(workspaces)
    .values({ name: 'default' })
    .onConflictDoNothing()
    .returning();

  const workspaceId = ws?.workspaceId ?? 1;

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD env var is required for seeding. Usage: ADMIN_PASSWORD=YourSecurePass npm run db:seed');
  }
  const adminHash = await hashPassword(adminPassword);

  const [u] = await db
    .insert(users)
    .values({ email: 'admin@example.com', passwordHash: adminHash, isAdmin: true })
    .onConflictDoNothing()
    .returning();

  // If user already exists (conflict), update their password hash
  if (!u) {
    await db
      .update(users)
      .set({ passwordHash: adminHash, isAdmin: true })
      .where(eq(users.email, 'admin@example.com'));
  }

  const userId = u?.userId ?? 1;

  // Add user as workspace owner
  await db
    .insert(workspaceMembers)
    .values({
      workspaceId,
      userId,
      role: 'owner',
    })
    .onConflictDoNothing();

  const groups = [
    { groupId: 'main', title: 'Основное', sortOrder: 10 },
    { groupId: 'finance', title: 'Финансы', sortOrder: 15 },
    { groupId: 'price', title: 'Цена', sortOrder: 20 },
    { groupId: 'funnel_all', title: 'Воронка (все)', sortOrder: 30 },
    { groupId: 'funnel_org', title: 'Воронка (орг)', sortOrder: 40 },
    { groupId: 'ads', title: 'Реклама', sortOrder: 50 },
    { groupId: 'ads_manual', title: 'Реклама (manual)', sortOrder: 55 },
    { groupId: 'ads_unified', title: 'Реклама (unified)', sortOrder: 56 },
    { groupId: 'stocks', title: 'Остатки', sortOrder: 60 },
  ];

  for (const g of groups) {
    await db
      .insert(pulseMetricGroups)
      .values(g)
      .onConflictDoNothing();
  }

  // Metric catalog (MVP): what the Pulse web overview currently supports.
  const metrics = [
    {
      metricId: 'orders_count',
      groupId: 'main',
      title: 'Заказы (шт)',
      unit: 'шт',
      sortOrder: 10,
      isDefaultEnabled: true,
    },
    {
      metricId: 'orders_rub',
      groupId: 'main',
      title: 'Заказы (₽)',
      unit: '₽',
      sortOrder: 15,
      isDefaultEnabled: true,
    },
    {
      metricId: 'sales_count',
      groupId: 'main',
      title: 'Продажи (шт)',
      unit: 'шт',
      sortOrder: 18,
      isDefaultEnabled: false,
    },
    {
      metricId: 'sales_rub',
      groupId: 'main',
      title: 'Продажи (₽)',
      unit: '₽',
      sortOrder: 20,
      isDefaultEnabled: true,
    },
    {
      metricId: 'adv_spend_rub',
      groupId: 'ads',
      title: 'Рекл. расход (₽)',
      unit: '₽',
      sortOrder: 10,
      isDefaultEnabled: true,
    },
    {
      metricId: 'drr_percent',
      groupId: 'ads',
      title: 'ДРР (%)',
      unit: '%',
      sortOrder: 20,
      isDefaultEnabled: true,
    },
    {
      metricId: 'adv_manual_spend_rub',
      groupId: 'ads_manual',
      title: 'Рекл. расход manual (₽)',
      unit: '₽',
      sortOrder: 10,
      isDefaultEnabled: false,
    },
    {
      metricId: 'adv_manual_drr_percent',
      groupId: 'ads_manual',
      title: 'ДРР manual (%)',
      unit: '%',
      sortOrder: 20,
      isDefaultEnabled: false,
    },
    {
      metricId: 'adv_unified_spend_rub',
      groupId: 'ads_unified',
      title: 'Рекл. расход unified (₽)',
      unit: '₽',
      sortOrder: 10,
      isDefaultEnabled: false,
    },
    {
      metricId: 'adv_unified_drr_percent',
      groupId: 'ads_unified',
      title: 'ДРР unified (%)',
      unit: '%',
      sortOrder: 20,
      isDefaultEnabled: false,
    },
    {
      metricId: 'payout_rub',
      groupId: 'finance',
      title: 'Выплата (₽)',
      unit: '₽',
      sortOrder: 10,
      isDefaultEnabled: false,
    },
    {
      metricId: 'additional_payment_rub',
      groupId: 'finance',
      title: 'Доп. выплаты (₽)',
      unit: '₽',
      sortOrder: 20,
      isDefaultEnabled: false,
    },
    {
      metricId: 'commission_rub',
      groupId: 'finance',
      title: 'Комиссия (₽)',
      unit: '₽',
      sortOrder: 30,
      isDefaultEnabled: false,
    },
    {
      metricId: 'logistics_rub',
      groupId: 'finance',
      title: 'Логистика (₽)',
      unit: '₽',
      sortOrder: 40,
      isDefaultEnabled: false,
    },
    {
      metricId: 'storage_rub',
      groupId: 'finance',
      title: 'Хранение (₽)',
      unit: '₽',
      sortOrder: 50,
      isDefaultEnabled: false,
    },
    {
      metricId: 'penalty_rub',
      groupId: 'finance',
      title: 'Штрафы (₽)',
      unit: '₽',
      sortOrder: 60,
      isDefaultEnabled: false,
    },
    {
      metricId: 'acquiring_rub',
      groupId: 'finance',
      title: 'Эквайринг (₽)',
      unit: '₽',
      sortOrder: 70,
      isDefaultEnabled: false,
    },
    {
      metricId: 'returns_count',
      groupId: 'finance',
      title: 'Возвраты (шт)',
      unit: 'шт',
      sortOrder: 75,
      isDefaultEnabled: false,
    },
    {
      metricId: 'margin_rub',
      groupId: 'main',
      title: 'Маржа (₽)',
      unit: '₽',
      sortOrder: 30,
      isDefaultEnabled: true,
    },
    {
      metricId: 'margin_percent',
      groupId: 'main',
      title: 'Маржинальность (%)',
      unit: '%',
      sortOrder: 35,
      isDefaultEnabled: false,
    },
    {
      metricId: 'net_profit_rub',
      groupId: 'main',
      title: 'Чистая прибыль (₽)',
      unit: '₽',
      sortOrder: 40,
      isDefaultEnabled: true,
    },
    {
      metricId: 'roi_percent',
      groupId: 'main',
      title: 'ROI (%)',
      unit: '%',
      sortOrder: 140,
      isDefaultEnabled: false,
    },

    // Price (orders)
    {
      metricId: 'price_no_spp_rub',
      groupId: 'price',
      title: 'Цена без СПП (₽)',
      unit: '₽',
      sortOrder: 10,
      isDefaultEnabled: false,
    },
    {
      metricId: 'spp_percent',
      groupId: 'price',
      title: 'СПП (%)',
      unit: '%',
      sortOrder: 20,
      isDefaultEnabled: false,
    },
    {
      metricId: 'price_with_spp_rub',
      groupId: 'price',
      title: 'Цена с СПП (₽)',
      unit: '₽',
      sortOrder: 30,
      isDefaultEnabled: false,
    },

    // Funnel (all)
    {
      metricId: 'view_count',
      groupId: 'funnel_all',
      title: 'Просмотры',
      unit: 'шт',
      sortOrder: 10,
      isDefaultEnabled: false,
    },
    {
      metricId: 'open_card_count',
      groupId: 'funnel_all',
      title: 'Открытия карточки',
      unit: 'шт',
      sortOrder: 20,
      isDefaultEnabled: false,
    },
    {
      metricId: 'add_to_cart_count',
      groupId: 'funnel_all',
      title: 'Добавления в корзину',
      unit: 'шт',
      sortOrder: 30,
      isDefaultEnabled: false,
    },
    {
      metricId: 'add_to_wishlist_count',
      groupId: 'funnel_all',
      title: 'Добавления в избранное',
      unit: 'шт',
      sortOrder: 40,
      isDefaultEnabled: false,
    },
    {
      metricId: 'funnel_order_count',
      groupId: 'funnel_all',
      title: 'Заказы (воронка)',
      unit: 'шт',
      sortOrder: 50,
      isDefaultEnabled: false,
    },
    {
      metricId: 'buyout_count',
      groupId: 'funnel_all',
      title: 'Продажи факт (шт)',
      unit: 'шт',
      sortOrder: 60,
      isDefaultEnabled: false,
    },
    {
      metricId: 'buyout_sum_rub',
      groupId: 'funnel_all',
      title: 'Продажи факт (₽)',
      unit: '₽',
      sortOrder: 65,
      isDefaultEnabled: false,
    },
    {
      metricId: 'cancel_count',
      groupId: 'funnel_all',
      title: 'Отмены (шт)',
      unit: 'шт',
      sortOrder: 68,
      isDefaultEnabled: false,
    },
    {
      metricId: 'buyout_percent',
      groupId: 'funnel_all',
      title: 'Выкуп (%)',
      unit: '%',
      sortOrder: 70,
      isDefaultEnabled: false,
    },
    {
      metricId: 'view_to_open_percent',
      groupId: 'funnel_all',
      title: 'View→Open (%)',
      unit: '%',
      sortOrder: 80,
      isDefaultEnabled: false,
    },

    // Stocks
    {
      metricId: 'stock_qty',
      groupId: 'stocks',
      title: 'На складе (шт)',
      unit: 'шт',
      sortOrder: 10,
      isDefaultEnabled: false,
    },
    {
      metricId: 'stock_in_way_to',
      groupId: 'stocks',
      title: 'В пути ДО (шт)',
      unit: 'шт',
      sortOrder: 20,
      isDefaultEnabled: false,
    },
    {
      metricId: 'stock_in_way_from',
      groupId: 'stocks',
      title: 'В пути ОТ (шт)',
      unit: 'шт',
      sortOrder: 30,
      isDefaultEnabled: false,
    },
    {
      metricId: 'stock_money_rub',
      groupId: 'stocks',
      title: 'Деньги в остатках (₽)',
      unit: '₽',
      sortOrder: 40,
      isDefaultEnabled: false,
    },
    {
      metricId: 'turnover_days',
      groupId: 'stocks',
      title: 'Оборачиваемость (дн)',
      unit: 'дн',
      sortOrder: 50,
      isDefaultEnabled: false,
    },
    {
      metricId: 'open_to_cart_percent',
      groupId: 'funnel_all',
      title: 'Open→Cart (%)',
      unit: '%',
      sortOrder: 90,
      isDefaultEnabled: false,
    },
    {
      metricId: 'cart_to_order_percent',
      groupId: 'funnel_all',
      title: 'Cart→Order (%)',
      unit: '%',
      sortOrder: 100,
      isDefaultEnabled: false,
    },
  ];

  for (const m of metrics) {
    await db
      .insert(pulseMetricsCatalog)
      .values(m)
      .onConflictDoNothing();
  }

  console.log('Seed complete', { workspaceId, userId });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
