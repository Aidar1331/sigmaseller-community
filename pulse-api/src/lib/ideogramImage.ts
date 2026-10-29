import { env } from '../env.js';
import { BadRequestError } from './errors.js';

export async function generateIdeogramImageBase64(_prompt: string): Promise<string> {
  if (!env.IDEOGRAM_API_KEY) {
    throw new BadRequestError('IDEOGRAM_API_KEY is not configured');
  }
  throw new BadRequestError('Ideogram image provider not implemented yet');
}
