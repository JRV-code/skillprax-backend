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
  // 1. Scout live candidates
  const searchQuery = `${topic} ${stepTitle} practical tutorial guide documentation`;
  const candidates = await harvestLiveCandidates(searchQuery, tavilyKey);

  // 2. Groq Master Educator Prompt
  const systemPrompt = `You are the master instructor for SkillPrax. You reject boilerplate and empty responses.
You provide the student with deep mental models, direct learning materials, and rigorous evaluation.
You MUST ALWAYS curate between 1 and 4 high-yield, direct destination study resources.
NEVER return an empty "resources" array.
Output your response strictly as a single valid JSON object without markdown fences.`;

  const userPrompt = `
Domain: "${domain}"
Discipline / Topic: "${topic}"
Step ${stepIndex}: "${stepTitle}"
Student's Target Goal: "${goal || 'Full-stack mastery'}"

LIVE CANDIDATES HARVESTED FROM TAVILY:
${JSON.stringify(candidates, null, 2)}

EDUCATOR MANDATE:
1. "whatYouWillLearn":
   Write a rich 2-3 paragraph breakdown of foundational concepts, mechanisms, and common developer pitfalls. Teach the core mental model directly.

2. "coreKeyTakeaways":
   List 3 to 5 concrete terms, architectural patterns, or syntax rules.

3. "practicalApplication":
   Explain how this step directly enables the student to achieve their real-world goal: "${goal}".

4. ATOMIC COMPETENCY UNITS & QUIZ SIZING ("questionCount" & "assessableUnits"):
   - Identify the core testable competencies (mechanisms, edge cases, trade-offs).
   - Set "questionCount" strictly equal to the number of assessable units (typically 3 to 8). Do NOT default to 5.

5. AUTONOMOUS RESOURCE CURATION ("resources"):
   - Review Tavily's candidate links above. Pick the best direct links that genuinely teach this step.
   - CRITICAL FALLBACK RULE: If Tavily returned 0 or weak candidates, YOU as the master educator MUST supply direct canonical, authoritative documentation links from your own knowledge (e.g. direct documentation on MDN Web Docs, React.dev, Nodejs.org, GitHub official guides, or Wikipedia articles like "https://en.wikipedia.org/wiki/Full-stack_web_development").
   - NEVER output search query links (no "youtube.com/results?search_query=..." and no "google.com/search?q=...").
   - Provide between 1 and 4 direct destination resources. NEVER RETURN AN EMPTY ARRAY.
   - Give each resource a contextual badge (e.g., "Official Guide", "Core Architecture Walkthrough", "Interactive Sandbox", "Foundational Reading").
   - In "studyGuidance", explain exactly what the student should focus on.

JSON SCHEMA:
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
    console.error("[Groq Generation Error]:", errText);
    throw new Error(`Groq generation failed: ${errText}`);
  }

  const groqData: any = await groqRes.json();
  const rawContent = groqData.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(rawContent);

  console.log(`[Groq] Curated ${parsed.resources?.length || 0} direct resources.`);
  return parsed;
}
