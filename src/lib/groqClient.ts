import { getEffectiveKeys } from './keyManager';

export interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqChatCompletionOptions {
  model?: string;
  messages: GroqChatMessage[];
  response_format?: { type: 'json_object' | 'text' };
  temperature?: number;
  max_tokens?: number;
}

export const groq = {
  chat: {
    completions: {
      async create(options: GroqChatCompletionOptions): Promise<{ choices: Array<{ message: { content: string } }> }> {
        const { groqKey } = await getEffectiveKeys();
        if (!groqKey) {
          throw new Error('Groq API Key is not configured in .env or /admin');
        }

        const model = options.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

        const body: Record<string, any> = {
          model,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
        };

        if (options.response_format) {
          body.response_format = options.response_format;
        }
        body.max_tokens = options.max_tokens || 4500;

        const candidateModels = [
          model,
          'llama-3.3-70b-versatile',
          'llama-3.1-8b-instant',
          'qwen/qwen3.8-27b',
          'openai/gpt-oss-120b',
        ];

        let lastError: any = null;

        for (const candidate of Array.from(new Set(candidateModels))) {
          try {
            body.model = candidate;
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${groqKey}`,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(45000),
            });

            if (res.ok) {
              const data: any = await res.json();
              return {
                choices: [
                  {
                    message: {
                      content: data.choices?.[0]?.message?.content || '',
                    },
                  },
                ],
              };
            }

            const errText = await res.text();
            if (res.status === 400 && (errText.includes('max completion tokens') || errText.includes('json_validate_failed'))) {
              body.max_tokens = 8000;
              continue;
            }
            lastError = new Error(`Groq API request failed (${res.status}): ${errText}`);
            // If error is not 404/model_not_found, break
            if (res.status !== 404 && !errText.includes('model_not_found')) {
              break;
            }
          } catch (e: any) {
            lastError = e;
          }
        }

        throw lastError || new Error('Groq completion failed across candidate models');
      },
    },
  },
};

export default groq;
