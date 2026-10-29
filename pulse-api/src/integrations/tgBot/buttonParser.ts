/**
 * Strips `[BUTTON: <label> | <callback>]` markers from LLM output and
 * returns clean message text + the inline-keyboard rows. See the
 * "CONTEXTUAL UI BUTTONS" section in systemPrompt.ts for the syntax
 * contract the model is instructed to follow.
 *
 * Multiple markers in one response → multiple buttons (one per row).
 * The order is preserved. Telegram callback_data has a 64-byte limit;
 * anything longer is silently dropped (logged in caller).
 */

import log from '../../lib/logger.js';

const logger = log.child({ module: 'tgBotButtonParser' });

const BUTTON_RE = /\[BUTTON:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]/g;
const MAX_BUTTONS = 4;
const MAX_CALLBACK_BYTES = 64;

export interface ButtonRow {
  text: string;
  callback_data: string;
}

export interface ParsedLLMResponse {
  text: string;                // message with markers stripped
  buttons: ButtonRow[][];      // each row is one button (we display one button per row for mobile readability)
}

export function parseLLMButtons(raw: string): ParsedLLMResponse {
  const buttons: ButtonRow[] = [];
  const stripped = raw.replace(BUTTON_RE, (_, rawLabel: string, rawCallback: string) => {
    if (buttons.length >= MAX_BUTTONS) return ''; // silently cap
    const label = rawLabel.trim();
    const callback = rawCallback.trim();
    if (!label || !callback) return '';
    // Telegram callback_data is binary-counted in bytes
    if (Buffer.byteLength(callback, 'utf8') > MAX_CALLBACK_BYTES) {
      logger.warn({ callback }, 'LLM button callback too long, dropped');
      return '';
    }
    buttons.push({ text: label, callback_data: callback });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return {
    text: stripped,
    buttons: buttons.map((b) => [b]),
  };
}
