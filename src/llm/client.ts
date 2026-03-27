import Anthropic from '@anthropic-ai/sdk';
import { LLMCallConfig } from '../types';

// Try to set up proxy if available (for containerized environments)
// Use dynamic import of 'undici' — if it fails, skip proxy setup
try {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
} catch {}

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6-20250516',
};

export class LLMClient {
  private client: Anthropic;
  private callCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Main call method with retries.
   * Maps short model name to full ID, calls the API, and retries up to 2 times
   * on failure with exponential backoff (1s, 2s).
   */
  async call(config: LLMCallConfig): Promise<string> {
    const model = MODEL_MAP[config.model] || config.model;
    const maxTokens = config.maxTokens ?? 512;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          system: config.systemPrompt,
          messages: [
            { role: 'user', content: config.userPrompt },
          ],
        });

        this.callCount++;
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;

        const textBlock = response.content.find((block) => block.type === 'text');
        return textBlock ? textBlock.text : '';
      } catch (error: any) {
        if (attempt < maxAttempts) {
          const backoffMs = attempt * 1000; // 1s, 2s
          console.warn(
            `[LLMClient] Attempt ${attempt}/${maxAttempts} failed: ${error.message ?? error}. Retrying in ${backoffMs}ms...`
          );
          await sleep(backoffMs);
        } else {
          throw error;
        }
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error('Unexpected: exhausted retries without throwing');
  }

  /**
   * Call the LLM and parse JSON from the response.
   * If parsing fails, retries once with an appended instruction to return valid JSON.
   */
  async callJson<T = any>(config: LLMCallConfig): Promise<T> {
    const rawText = await this.call(config);
    const parsed = tryParseJson(rawText);
    if (parsed !== null) {
      return parsed as T;
    }

    // Retry with appended instruction
    const retryConfig: LLMCallConfig = {
      ...config,
      userPrompt:
        config.userPrompt +
        '\n\nYour previous response was not valid JSON. Respond with ONLY a valid JSON object/array, no markdown, no explanation.',
    };
    const retryText = await this.call(retryConfig);
    const retryParsed = tryParseJson(retryText);
    if (retryParsed !== null) {
      return retryParsed as T;
    }

    throw new Error(
      `[LLMClient] Failed to parse JSON from LLM response after retry. Raw text:\n${retryText}`
    );
  }

  /**
   * Get usage stats.
   * Cost estimated using haiku rates: $0.80/M input, $4/M output.
   */
  getStats(): { calls: number; inputTokens: number; outputTokens: number; estimatedCost: number } {
    const estimatedCost =
      (this.totalInputTokens / 1_000_000) * 0.8 +
      (this.totalOutputTokens / 1_000_000) * 4;

    return {
      calls: this.callCount,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      estimatedCost,
    };
  }
}

/**
 * Exported utility: parse JSON from LLM responses.
 * Handles markdown code blocks and extracts JSON objects/arrays.
 */
export function tryParseJson(text: string): any | null {
  let s = text.trim();

  // Strip markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    s = codeBlock[1].trim();
  }

  try {
    return JSON.parse(s);
  } catch {
    // Try extracting first JSON object or array
    const match = s.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return null;
  }
}

/** Sleep utility for backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
