import { requireSellerAiKey } from '../services/sellerAiCredentials.js';
import { env } from '../env.js';
import { BadRequestError } from './errors.js';

export async function generateImageBase64(prompt: string): Promise<string> {
  if (!(await requireSellerAiKey('openai'))) {
    throw new BadRequestError('OPENAI_API_KEY is not configured');
  }

  const model = env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(await requireSellerAiKey('openai'))}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size: '1024x1024',
      response_format: 'b64_json',
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new BadRequestError(`OpenAI image error: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new BadRequestError('OpenAI image response missing b64_json');
  }

  return b64 as string;
}
