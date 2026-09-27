import { harvestLiveCandidates } from "../search/tavily";

export async function runPedagogicalCuratorPipeline({
  domain,
  topic,
  stepIndex,
  stepTitle,
  goal,
  groqKey,
  tavilyKey
}: {
  domain: string;
  topic: string;
  stepIndex: number;
  stepTitle: string;
  goal: string;
  groqKey: string;
  tavilyKey?: string | null;
}) {
  const searchQuery = `${topic} ${stepTitle} practical tutorial guide documentation`;
  const candidates = await harvestLiveCandidates(searchQuery, tavilyKey);

  const systemPrompt = `You are the master instructor and curriculum architect for SkillPrax.
You reject rigid templates, fixed quotas, and superficial boilerplate.
Your mandate is genuine student mastery: you craft deep conceptual lessons, curate authentic destination materials, and determine the exact number of evaluation questions required.
NEVER return an empty resources array.
NEVER return search query links (no youtube.com/results, no google.com/search).
You must respond strictly with a valid JSON object matching the requested schema.`;

  const userPrompt = `
Domain Category: "${domain}"
Discipline / Topic: "${topic}"
Step ${stepIndex}: "${stepTitle}"
Student's Target Goal: "${goal || 'Deep Mastery'}"

Live Web Candidates Scouted by Tavily:
${JSON.stringify(candidates, null, 2)}

EDUCATOR RESPONSIBILITIES:
1. "whatYouWillLearn":
   Write a rich 2-3 paragraph breakdown explaining foundational mechanics, mental models, governing principles, and common cognitive traps for this step. Teach the concepts directly.

2. "coreKeyTakeaways":
   List 3 to 5 concrete terms, architectural patterns, syntax rules, or governing laws.

3. "practicalApplication":
   Explain how this specific step enables the student to achieve their real-world goal: "${goal}".

4. ATOMIC COMPETENCY UNITS & QUIZ SIZING ("questionCount" & "assessableUnits"):
   - Deconstruct this step into its core Atomic Competency Units (individual edge cases, failure points, trade-offs, and rules that must be evaluated).
   - Set "questionCount" strictly equal to the number of assessable units (typically 3 to 8). Do NOT default to 5.

5. UNCONSTRAINED RESOURCE SELECTION ("resources"):
   - Review Tavily's candidates above. Select the direct destination links that genuinely teach this concept.
   - If Tavily returned 0 or weak results, supply direct canonical, authoritative links from your own knowledge (e.g. direct documentation on MDN Web Docs, React.dev, official project documentation, or relevant Wikipedia articles like "https://en.wikipedia.org/wiki/Full-stack_web_development").
   - NEVER return search query links.
   - Choose between 1 and 4 direct destination resources based on pedagogical necessity. NEVER return an empty array.
   - Assign each resource a custom badge (e.g., "Core Walkthrough", "Official Specification", "Interactive Sandbox", "Foundational Reading").
   - In "studyGuidance", write actionable advice telling the student what to focus on.

Respond ONLY with this JSON schema:
{
  "whatYouWillLearn": "string",
  "coreKeyTakeaways": ["string"],
  "practicalApplication": "string",
  "assessableUnits": ["string"],
  "questionCount": number,
  "resources": [
    {
      "title": "string",
      "url": "string",
      "badge": "string",
      "type": "video" | "pdf" | "wiki" | "guide" | "website" | "interactive",
      "studyGuidance": "string"
    }
  ]
}
`;

  console.log(`[Groq] Curating step ${stepIndex} with LLaMA-3.3-70B...`);
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqKey.trim()}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.25,
      max_tokens: 3500
    })
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    console.error("[Groq Error]:", errText);
    throw new Error(`Groq generation failed: ${errText}`);
  }

  const groqData: any = await groqRes.json();
  const rawContent = groqData.choices[0]?.message?.content || "{}";
  return JSON.parse(rawContent);
}
