import { generateImage } from '../services/ai/gemini.js';
export async function generateGeminiImageBase64(prompt: string): Promise<string> {
  const images = await generateImage({ prompt, numberOfImages: 1 });
  return images[0].data.toString('base64');
}
