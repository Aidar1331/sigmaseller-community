import { getChats, getUnreadCount } from '../../integrations/wb/chats.js';
import { getWbApiKey } from '../../integrations/wb/wbClient.js';
import { sanitizeUserText, wrapBuyerText } from './sanitizeUserText.js';

interface QueryChatsArgs {
  status?: 'active' | 'closed';
  unreadOnly?: boolean;
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryChats(args: QueryChatsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const apiKey = await getWbApiKey(wsId, shopId);
    if (!apiKey) return JSON.stringify({ error: 'WB API ключ не настроен' });

    const [chatsResult, unreadResult] = await Promise.all([
      getChats(apiKey, {
        status: args.status,
        unreadOnly: args.unreadOnly,
        limit: args.limit ?? 30,
      }),
      getUnreadCount(apiKey),
    ]);

    const chats = chatsResult?.data ?? [];

    return JSON.stringify({
      unreadCount: unreadResult?.count ?? 0,
      totalReturned: chats.length,
      // buyerName / lastMessage / productName originate from buyer-controlled
      // input on WB. Wrap each in a <buyer_*> tag so the system prompt can tell
      // the model to treat the contents as data, never as instructions.
      chats: chats.map((c: any) => ({
        chatId: c.id,
        buyerName: sanitizeUserText(c.buyerName ?? 'Покупатель', 80),
        lastMessage: wrapBuyerText('buyer_chat_message', c.lastMessage?.text ?? '', { chatId: c.id, nmId: c.nmId }),
        lastMessageDate: c.lastMessage?.createdAt ?? c.updatedAt,
        isRead: c.isRead ?? true,
        status: c.status,
        nmId: c.nmId,
        productName: sanitizeUserText(c.productName, 200),
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Не удалось загрузить чаты' });
  }
}
