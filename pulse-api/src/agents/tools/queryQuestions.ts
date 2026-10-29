import { fetchWbQuestions, getUnansweredQuestionsCount } from '../../integrations/wb/feedbacks.js';
import { sanitizeUserText, wrapBuyerText } from './sanitizeUserText.js';

interface QueryQuestionsArgs {
  isAnswered?: boolean;
  nmId?: number;
  limit?: number;
  _workspaceId?: number;
  _shopId?: number;
  _userId?: number;
}

export async function queryQuestions(args: QueryQuestionsArgs): Promise<string> {
  const wsId = args._workspaceId;
  const shopId = args._shopId as number | undefined;
  if (!wsId) return JSON.stringify({ error: 'workspace not found' });

  try {
    const [questionsResult, unansweredResult] = await Promise.all([
      fetchWbQuestions(wsId, {
        isAnswered: args.isAnswered,
        nmId: args.nmId,
        take: args.limit ?? 50,
        order: 'dateDesc',
      }, shopId),
      getUnansweredQuestionsCount(wsId, shopId),
    ]);

    if (questionsResult.error) {
      return JSON.stringify({
        error: questionsResult.errorText || 'Ошибка загрузки вопросов из WB API',
      });
    }

    const questions = questionsResult.data?.questions ?? [];

    return JSON.stringify({
      unansweredCount: unansweredResult.count ?? 0,
      totalReturned: questions.length,
      // Buyer-controlled fields wrapped in <buyer_*> tags — see sanitizeUserText.
      // Question text and answer text are both untrusted input; productName
      // is seller-set but we still cap length defensively.
      questions: questions.map((q: any) => ({
        id: q.id,
        text: wrapBuyerText('buyer_question', q.text ?? '', { id: q.id, nmId: q.productDetails?.nmId }),
        productName: sanitizeUserText(q.productDetails?.productName, 200),
        nmId: q.productDetails?.nmId,
        isAnswered: q.state === 'answered',
        answer: q.answer?.text ? wrapBuyerText('seller_answer', q.answer.text, { id: q.id }) : null,
        createdDate: q.createdDate,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'Не удалось загрузить вопросы' });
  }
}
