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
        if (options.max_tokens) {
          body.max_tokens = options.max_tokens;
        }

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45000),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Groq API request failed (${res.status}): ${errText}`);
        }

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
      },
    },
  },
};

export default groq;
