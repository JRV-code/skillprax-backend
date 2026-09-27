import { GoogleGenAI } from '@google/genai';
import { FREE_AI_FLEET } from './orchestrator';

/**
 * Executes a prompt against Google Gemini with Native Google Search Grounding
 * and robust JSON extraction.
 */
export async function generateWithGemini(prompt: string, apiKey: string): Promise<any> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('Gemini API key is missing.');
  }

  const modelsToTry = [FREE_AI_FLEET.gemini.primaryModel, FREE_AI_FLEET.gemini.fallbackModel, 'gemini-2.5-flash'];
  let lastError = '';

  for (const modelName of modelsToTry) {
    // 1. Try official SDK with Google Search Grounding
    try {
      const ai = new GoogleGenAI({ apiKey: cleanKey });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          temperature: 0.2,
          tools: [{ googleSearch: {} }],
        },
      });

      const rawText = response.text || '';
      if (rawText) {
        return parseAndExtractJson(rawText);
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
    }

    // 2. Direct REST endpoint with native google_search tool enabled
    try {
      const url = `${FREE_AI_FLEET.gemini.endpoint}/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2,
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data: any = await res.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (rawText) {
          return parseAndExtractJson(rawText);
        }
      } else {
        const errData: any = await res.json().catch(() => ({}));
        lastError = errData.error?.message || `Gemini API error ${res.status}: ${res.statusText}`;
        if (res.status !== 404 && !lastError.includes('NOT_FOUND')) {
          break;
        }
      }
    } catch (restErr: any) {
      lastError = restErr?.message || String(restErr);
    }
  }

  throw new Error(`Gemini generation failed: ${lastError}`);
}

/**
 * Strips markdown code fences and parses JSON safely, handling extra citation text.
 */
export function parseAndExtractJson(rawText: string): any {
  // Strip markdown code fences if wrapped
  const cleanedText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleanedText);
  } catch (e) {
    // If parsing fails due to citation text, extract the outermost JSON object
    const match = cleanedText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
    throw new Error('Failed to parse valid JSON from Gemini grounded response.');
  }
}
