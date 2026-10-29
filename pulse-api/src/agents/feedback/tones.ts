export type FeedbackTone = 'neutral' | 'friendly' | 'emotional' | 'premium';

export interface ToneConfig {
  name: FeedbackTone;
  systemPromptPart: string;
  maxLength: number;
  emojiAllowed: boolean;
  signOff: string;
}

export const TONE_CONFIGS: Record<FeedbackTone, ToneConfig> = {
  neutral: {
    name: 'neutral',
    systemPromptPart: 'Отвечай вежливо, нейтрально и по делу. Без эмоций. Будь кратким.',
    maxLength: 350,
    emojiAllowed: false,
    signOff: 'С уважением, команда магазина',
  },
  friendly: {
    name: 'friendly',
    systemPromptPart: 'Отвечай дружелюбно, тепло и с благодарностью. Покажи заботу о покупателе.',
    maxLength: 500,
    emojiAllowed: true,
    signOff: 'Спасибо за обратную связь! Будем рады видеть вас снова',
  },
  emotional: {
    name: 'emotional',
    systemPromptPart: 'Отвечай эмоционально, с энтузиазмом и искренностью. Если негативный отзыв — покажи сочувствие и желание помочь.',
    maxLength: 600,
    emojiAllowed: true,
    signOff: 'Мы очень ценим ваше мнение!',
  },
  premium: {
    name: 'premium',
    systemPromptPart: 'Отвечай в стиле премиум-бренда: сдержанно, элегантно, без фамильярности. Подчёркивай качество и внимание к деталям.',
    maxLength: 400,
    emojiAllowed: false,
    signOff: 'С благодарностью, ваш персональный менеджер',
  },
};
