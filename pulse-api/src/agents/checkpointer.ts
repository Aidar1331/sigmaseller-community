/**
 * LangGraph PostgresSaver checkpointer.
 *
 * Uses the existing Pulse database pool for storing LangGraph
 * thread checkpoints (conversation state, tool call history, etc.)
 *
 * Tables are auto-created by PostgresSaver.setup():
 *   - checkpoints
 *   - checkpoint_writes
 *   - checkpoint_blobs
 */

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { env } from '../env.js';

let _saver: PostgresSaver | null = null;

/**
 * Get or create the singleton PostgresSaver instance.
 * Call setup() once on first access to create checkpoint tables.
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (_saver) return _saver;

  const saver = PostgresSaver.fromConnString(env.DATABASE_URL);

  // Creates checkpoint tables if they don't exist
  await saver.setup();

  _saver = saver;
  return saver;
}
