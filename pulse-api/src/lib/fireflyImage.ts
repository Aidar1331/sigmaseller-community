import { env } from '../env.js';
import { BadRequestError } from './errors.js';

export async function generateFireflyImageBase64(_prompt: string): Promise<string> {
  if (!env.FIREFLY_API_KEY) {
    throw new BadRequestError('FIREFLY_API_KEY is not configured');
  }
  throw new BadRequestError('Firefly image provider not implemented yet');
}
