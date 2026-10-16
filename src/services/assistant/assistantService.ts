import prisma from '../../lib/prisma';
import { db } from '../../lib/db';
import { getEffectiveKeys } from '../../lib/keyManager';
import { buildAssistantSystemPrompt } from './appKnowledgeEngine';

export interface TavilySource {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
}

export interface StreamEvent {
  type: 'status' | 'token' | 'sources' | 'done' | 'error';
  message?: string;
  content?: string;
  sources?: TavilySource[];
  messageId?: string;
  sessionTitle?: string;
}

/**
 * Intelligent trigger detection for latest / real-time information
 */
export function shouldTriggerTavilySearch(prompt: string, force?: boolean): boolean {
  if (force) return true;

  const lower = prompt.toLowerCase();
  const searchTriggers = [
    'latest', 'current', 'news', 'recent', 'today', 'this year', '2025', '2026', '2024',
    'rules update', 'world cup', 'olympics', 'ranking', 'champion', 'tournament',
    'near me', 'academies in', 'clubs in', 'equipment price', 'where to buy', 'amazon',
    'verify', 'who won', 'match result', 'schedule', 'new feature'
  ];

  return searchTriggers.some((t) => lower.includes(t));
}

/**
 * Execute real-time search via Tavily API
 */
export async function performTavilySearch(query: string): Promise<{ summary: string; sources: TavilySource[] }> {
  const { tavilyKey } = await getEffectiveKeys();
  if (!tavilyKey) {
    return { summary: '', sources: [] };
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: query.slice(0, 400),
        search_depth: 'basic',
        max_results: 5,
        include_domains: [],
        exclude_domains: ['facebook.com', 'twitter.com', 'instagram.com', 'pinterest.com'],
      }),
    });

    if (!res.ok) {
      console.warn('[Tavily] Search response not OK:', res.status);
      return { summary: '', sources: [] };
    }

    const data: any = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];

    const sources: TavilySource[] = [];
    const snippets: string[] = [];

    for (const r of results) {
      let domain = 'web-source';
      try {
        domain = new URL(r.url).hostname.replace(/^www\./, '');
      } catch (_) {}

      sources.push({
        title: r.title || domain,
        url: r.url,
        domain,
        snippet: r.content || '',
      });

      snippets.push(`- **[${r.title || domain}](${r.url})**: ${r.content || ''}`);
    }

    const summary = snippets.length > 0
      ? `\n\n[LIVE TAVILY WEB SEARCH RESULTS FOR: "${query}"]\n${snippets.join('\n')}\n`
      : '';

    return { summary, sources };
  } catch (err) {
    console.warn('[Tavily] Search error:', err);
    return { summary: '', sources: [] };
  }
}

import { resolveActiveGroqModel, DEFAULT_GROQ_PRIORITY_MODELS } from '../ai';

const GROQ_MODEL_CHAIN = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
];

/**
 * Quick 3-5 word title summarizer for new conversations
 */
export async function generateSessionTitle(firstPrompt: string, apiKey: string): Promise<string> {
  const cleanPrompt = firstPrompt.trim().slice(0, 300);

  for (const model of GROQ_MODEL_CHAIN) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'You generate short, punchy 3-5 word conversation titles from the user prompt. Do not use quotes or punctuation.',
            },
            {
              role: 'user',
              content: cleanPrompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 16,
        }),
      });

      if (res.ok) {
        const data: any = await res.json();
        const rawTitle = data?.choices?.[0]?.message?.content?.trim();
        if (rawTitle && rawTitle.length < 50) {
          return rawTitle.replace(/^["']|["']$/g, '');
        }
      }
    } catch (_) {}
  }

  // Fallback title
  const words = firstPrompt.trim().split(/\s+/).slice(0, 5).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New Conversation';
}

/**
 * Chat Session & Message Operations
 */
export async function listUserSessions(userId: string) {
  try {
    const sessions = await (prisma as any).aiChatSession?.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { messages: true },
        },
      },
    });
    if (sessions && Array.isArray(sessions)) return sessions;
  } catch (_) {}

  // Direct SQL Fallback
  const res = await db.query(
    `SELECT s.id, s.user_id as "userId", s.title, s.created_at as "createdAt", s.updated_at as "updatedAt",
            COUNT(m.id)::int as "messageCount"
     FROM ai_chat_sessions s
     LEFT JOIN ai_chat_messages m ON m.session_id = s.id
     WHERE s.user_id = $1
     GROUP BY s.id
     ORDER BY s.updated_at DESC`,
    [userId]
  );
  return res.rows || [];
}

export async function createChatSession(userId: string, title?: string) {
  const initialTitle = title || 'New Conversation';
  try {
    const session = await (prisma as any).aiChatSession?.create({
      data: {
        userId,
        title: initialTitle,
      },
    });
    if (session) return session;
  } catch (_) {}

  const res = await db.query(
    `INSERT INTO ai_chat_sessions (user_id, title) VALUES ($1, $2) RETURNING id, user_id as "userId", title, created_at as "createdAt", updated_at as "updatedAt"`,
    [userId, initialTitle]
  );
  return res.rows[0];
}

export async function getSessionMessages(sessionId: string, userId: string) {
  // Verify ownership
  let sessionOwner = false;
  try {
    const session = await (prisma as any).aiChatSession?.findUnique({
      where: { id: sessionId },
    });
    if (session && session.userId === userId) sessionOwner = true;
  } catch (_) {}

  if (!sessionOwner) {
    const checkRes = await db.query(
      `SELECT 1 FROM ai_chat_sessions WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [sessionId, userId]
    );
    if (!checkRes.rows || checkRes.rows.length === 0) {
      throw new Error('Chat session not found or unauthorized.');
    }
  }

  try {
    const messages = await (prisma as any).aiChatMessage?.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    if (messages && Array.isArray(messages)) return messages;
  } catch (_) {}

  const mRes = await db.query(
    `SELECT id, session_id as "sessionId", role, content, used_tavily_search as "usedTavilySearch", sources, created_at as "createdAt"
     FROM ai_chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );
  return mRes.rows || [];
}

export async function deleteChatSession(sessionId: string, userId: string) {
  try {
    await (prisma as any).aiChatSession?.deleteMany({
      where: { id: sessionId, userId },
    });
    return true;
  } catch (_) {}

  await db.query(`DELETE FROM ai_chat_sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
  return true;
}

export async function saveMessage(sessionId: string, role: 'user' | 'assistant', content: string, usedTavily = false, sources: any = null) {
  try {
    const msg = await (prisma as any).aiChatMessage?.create({
      data: {
        sessionId,
        role,
        content,
        usedTavilySearch: usedTavily,
        sources: sources ? sources : undefined,
      },
    });

    // Touch session updatedAt
    await (prisma as any).aiChatSession?.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    if (msg) return msg;
  } catch (_) {}

  const res = await db.query(
    `INSERT INTO ai_chat_messages (session_id, role, content, used_tavily_search, sources)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, session_id as "sessionId", role, content, used_tavily_search as "usedTavilySearch", sources, created_at as "createdAt"`,
    [sessionId, role, content, usedTavily, sources ? JSON.stringify(sources) : null]
  );

  await db.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
  return res.rows[0];
}

export async function updateSessionTitle(sessionId: string, title: string) {
  try {
    await (prisma as any).aiChatSession?.update({
      where: { id: sessionId },
      data: { title },
    });
  } catch (_) {
    await db.query(`UPDATE ai_chat_sessions SET title = $1, updated_at = NOW() WHERE id = $2`, [title, sessionId]);
  }
}

/**
 * Token-by-Token Autoregressive Stream Generator
 */
export async function* streamAssistantChat(params: {
  sessionId: string;
  userId: string;
  userPrompt: string;
  forceWebSearch?: boolean;
}): AsyncGenerator<StreamEvent> {
  const { sessionId, userId, userPrompt, forceWebSearch } = params;

  // 1. Save user prompt to database
  await saveMessage(sessionId, 'user', userPrompt);

  // 2. Fetch existing session history for multi-turn context
  const previousMessages = await getSessionMessages(sessionId, userId);
  const conversationHistory = previousMessages.map((m: any) => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
    content: m.content,
  }));

  // 3. Build Full System Prompt with auto-synced codebase knowledge and user context
  const systemPrompt = await buildAssistantSystemPrompt(userId);

  // 4. Check if live Tavily Web Search is needed
  let tavilyContext = '';
  let usedTavily = false;
  let sources: TavilySource[] = [];

  if (shouldTriggerTavilySearch(userPrompt, forceWebSearch)) {
    yield {
      type: 'status',
      message: '🌐 Searching live web sources via Tavily...',
    };

    const searchResult = await performTavilySearch(userPrompt);
    if (searchResult.sources.length > 0) {
      usedTavily = true;
      sources = searchResult.sources;
      tavilyContext = searchResult.summary;
      yield {
        type: 'sources',
        sources,
      };
    }
  }

  // 5. Compose Messages Array for Groq
  const { groqKey } = await getEffectiveKeys();
  if (!groqKey) {
    yield {
      type: 'error',
      message: 'Groq API Key is not configured. Please add GROQ_API_KEY to your .env or /admin config.',
    };
    return;
  }

  const promptWithLiveContext = tavilyContext
    ? `${userPrompt}\n\n${tavilyContext}\nInstructions: Incorporate these latest findings seamlessly into your response. Structure your answer cleanly with headings, bullet points, and key takeaways.`
    : userPrompt;

  const messagesPayload = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-10, -1), // Include recent multi-turn context
    { role: 'user', content: promptWithLiveContext },
  ];

  // 6. Call Groq with stream: true for Token-by-Token Autoregressive Generation with Fallback Chain
  let fullAssistantText = '';
  let streamSucceeded = false;
  let lastErrorMessage = '';

  const activeModel = await resolveActiveGroqModel(groqKey);
  const modelsToTry = Array.from(new Set([activeModel, ...GROQ_MODEL_CHAIN]));

  for (const model of modelsToTry) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messagesPayload,
          temperature: 0.5,
          max_tokens: 2048,
          stream: true,
        }),
      });

      if (!groqRes.ok) {
        const errBody = await groqRes.text().catch(() => '');
        lastErrorMessage = `Groq API error (${groqRes.status} on ${model}): ${errBody || groqRes.statusText}`;
        console.warn(`[AssistantService] Model ${model} returned ${groqRes.status}. Trying next model...`);
        continue;
      }

      const reader = groqRes.body?.getReader();
      if (!reader) {
        lastErrorMessage = `Groq response body reader could not be initialized for ${model}.`;
        continue;
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const deltaToken = parsed.choices?.[0]?.delta?.content;
              if (deltaToken) {
                fullAssistantText += deltaToken;
                yield {
                  type: 'token',
                  content: deltaToken,
                };
              }
            } catch (_) {
              // Buffer chunk split, ignore and continue
            }
          }
        }
      }

      if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
        if (buffer.trim().startsWith('data: ')) {
          try {
            const parsed = JSON.parse(buffer.trim().slice(6));
            const deltaToken = parsed.choices?.[0]?.delta?.content;
            if (deltaToken) {
              fullAssistantText += deltaToken;
              yield {
                type: 'token',
                content: deltaToken,
              };
            }
          } catch (_) {}
        }
      }

      if (fullAssistantText.trim().length > 0) {
        streamSucceeded = true;
        break; // Successfully streamed with this model
      }
    } catch (err: any) {
      lastErrorMessage = err?.message || 'Unknown network error during Groq stream.';
      console.warn(`[AssistantService] Error with model ${model}:`, err?.message);
    }
  }

  // Graceful recovery if all models failed
  if (!streamSucceeded || !fullAssistantText.trim()) {
    console.error('[AssistantService] Groq Streaming Fallback Activated. Last error:', lastErrorMessage);
    const recoveryText = `Hello! I encountered a temporary connection glitch with the primary inference model (${lastErrorMessage || 'Service busy'}). 

Here is quick guidance for what you need:
- **🧠 Skills Studio**: Access your cognitive skills roadmap and study materials.
- **📈 Sports Hub**: Train with daily drills, interactive countdown timers, and discover verified local sports academies.
- **👤 Profile Hub**: Check your active streak, current level, XP, and download your Calligraphy Completion Certificates.
- **❓ Socratic Gate Quizzes**: Complete your milestone evaluation with unique questions derived from your study material.

Feel free to ask your question again or explore any of the sections above!`;

    fullAssistantText = recoveryText;
    yield {
      type: 'token',
      content: recoveryText,
    };
  }

  // 7. Persist Assistant Response to Database
  const savedAssistantMsg = await saveMessage(
    sessionId,
    'assistant',
    fullAssistantText,
    usedTavily,
    sources.length > 0 ? sources : null
  );

  // 8. Auto-generate title if this is the first exchange
  let sessionTitle: string | undefined;
  if (previousMessages.length <= 1) {
    sessionTitle = await generateSessionTitle(userPrompt, groqKey);
    await updateSessionTitle(sessionId, sessionTitle);
  }

  // 9. Emit final done event
  yield {
    type: 'done',
    messageId: savedAssistantMsg?.id,
    sessionTitle,
    sources,
  };
}
