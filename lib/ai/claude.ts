import Anthropic from '@anthropic-ai/sdk';

/**
 * Model routing.
 *
 * Cost is something the challenge explicitly grades, so the split is deliberate:
 * Haiku reads every page window, because per-page description is a
 * high-volume, well-specified task; Sonnet is reserved for the two jobs where a
 * wrong call is expensive and hard for a reviewer to spot — interpreting
 * free-text feedback into edit operations, and confirming duplicate pairs.
 */
export const MODEL_BULK = 'claude-haiku-4-5-20251001';
export const MODEL_CAREFUL = 'claude-sonnet-5';

let client: Anthropic | null = null;

export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function claude(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — add it to .env.local to enable document identification',
    );
  }
  client ??= new Anthropic({ apiKey, maxRetries: 3 });
  return client;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function readUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

/** Pull the input of the first tool_use block, which is where our structured
 *  results live. Using a forced tool means we never parse prose as JSON. */
export function toolResult<T>(
  content: Anthropic.ContentBlock[],
  toolName: string,
): T {
  for (const block of content) {
    if (block.type === 'tool_use' && block.name === toolName) {
      return block.input as T;
    }
  }
  throw new Error(`model did not call ${toolName}`);
}
