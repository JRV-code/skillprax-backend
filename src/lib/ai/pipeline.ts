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
  tavilyKey?: string;
}) {
  // 1. Live Web Discovery via Tavily
  const searchQuery = `${topic} ${stepTitle} tutorial guide interactive reference`;
  const candidates = tavilyKey
    ? await harvestLiveCandidates(searchQuery, tavilyKey)
    : [];

  // 2. Groq Master Educator Prompt
  const systemPrompt = `You are a world-class mentor, researcher, and master educator dedicated to guiding a student toward true conceptual mastery.
You reject mechanical templates, rigid quotas, and superficial boilerplate.
You think like an authentic instructor: you evaluate what the student is trying to achieve, analyze the material discovered from the live web, and carefully construct an individualized lesson.
You decide the necessary study resources, author tailored study instructions, and determine the exact number of evaluation questions required to verify understanding.
Output your evaluation strictly in valid JSON without markdown fences.`;

  const userPrompt = `
Domain: "${domain}"
Discipline / Topic: "${topic}"
Step ${stepIndex}: "${stepTitle}"
Student's Target Goal: "${goal || 'Unconditional Mastery'}"

Verified Live Web Candidates Discovered by Tavily:
${JSON.stringify(candidates, null, 2)}

INSTRUCTIONS FOR THE EDUCATOR:

1. CONCEPTUAL ARCHITECTURE ("whatYouWillLearn"):
   - Write a comprehensive, multi-paragraph conceptual guide (2-3 rich paragraphs).
   - Unpack the core mental models, governing laws, underlying mechanics, and frequent cognitive traps or misconceptions. Avoid generic filler like "In this step you will learn foundational terms." Teach the actual concepts directly.

2. CONCRETE KNOWLEDGE UNITS ("coreKeyTakeaways"):
   - Provide 3 to 6 exact principles, mechanisms, formulas, or operational syntax rules that the student must mentally retain.

3. GOAL BRIDGE ("practicalApplication"):
   - Explicitly detail how mastering this step directly advances the student's real-world target goal: "${goal}".

4. ATOMIC COMPETENCY UNITS & QUIZ SIZING ("questionCount" & "assessableUnits"):
   - Deconstruct this step into its core Atomic Competency Units (individual edge cases, failure points, trade-offs, and rules that must be evaluated).
   - Store these in "assessableUnits".
   - Autonomously set "questionCount" strictly equal to the number of critical competencies that need testing (ranging between 3 and 10 based on true conceptual density). Do NOT default to 5.

5. UNCONSTRAINED RESOURCE SELECTION ("resources"):
   - Act as a mentor recommending materials. Do NOT adhere to a fixed template or arbitrary quota.
   - If one definitive source is all that is required, select 1. If genuine mastery requires a walkthrough, an authoritative specification, and an interactive simulation, select 3 or 4.
   - Use direct, authentic URLs from the candidate list whenever possible, or top-level verified domains (e.g. Wikipedia articles, official project docs, OpenLibrary textbooks).
   - NEVER provide search query links (no "youtube.com/results?search_query=..." and no "google.com/search?q=...").
   - Give each resource a tailored, contextual badge that describes its exact function (e.g., "Visual Mental Model", "Authoritative Specification", "Interactive Sandbox", "Field Diagnostic Guide", "Foundational Lecture").
   - Write specific "studyGuidance" telling the student *how* to engage with this material (e.g., "Skip to chapter 3 to see the state machine implementation", "Inspect the sequence diagram on page 12 before writing any code").

OUTPUT PURE JSON MATCHING THIS EXACT SCHEMA:
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

  // 3. Invoke Groq
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
      max_tokens: 3800
    })
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    throw new Error(`Groq pedagogical pipeline failed: ${errText}`);
  }

  const groqData: any = await groqRes.json();
  const rawContent = groqData.choices[0]?.message?.content || "{}";
  return JSON.parse(rawContent);
}
