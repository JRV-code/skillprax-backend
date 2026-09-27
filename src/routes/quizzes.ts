import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";
import { safeJsonParse } from "../lib/ai/orchestrator";
import { getActiveGroqModel } from "../lib/ai/pipeline";

const quizRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.post("/api/quizzes/generate", async (req, reply) => {
    try {
      const { stepId } = (req.body || {}) as { stepId: string };
      if (!stepId) return reply.status(400).send({ error: "stepId is required" });

      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true }
      });

      if (!step) return reply.status(404).send({ error: "Step not found" });

      const config = await prisma.adminConfig.findFirst();
      const groqKey = config?.groqKey || process.env.GROQ_API_KEY;

      if (!groqKey) {
        return reply.status(400).send({ error: "Groq key missing from Admin" });
      }

      // Use the question count determined by Groq during step creation
      const questionCount = step.questionCount || 5;

      const systemPrompt = `You are a rigorous diagnostic evaluator. You MUST return your output as a valid JSON object matching the requested schema. The response must be pure JSON with no markdown preamble.`;

      const userPrompt = `
Generate a scenario-based diagnostic evaluation quiz for Step: "${step.title}".
Topic: "${step.workspace.title}".
Core Takeaways: ${JSON.stringify(safeJsonParse(step.coreKeyTakeaways, []))}.
Assessable Competencies: ${JSON.stringify(safeJsonParse(step.assessableUnits, []))}.

REQUIREMENTS:
1. Generate exactly ${questionCount} scenario-based multiple choice questions.
2. Each question must test a concrete edge case, mechanism, or trade-off.
3. Provide 4 options (A, B, C, D).
4. For each question, explain why the correct option is right, and provide a diagnostic explanation for why each wrong option is incorrect.

Format your entire response as a valid JSON object:
{
  "questions": [
    {
      "id": 1,
      "scenario": "string",
      "question": "string",
      "options": [
        { "key": "A", "text": "string" },
        { "key": "B", "text": "string" },
        { "key": "C", "text": "string" },
        { "key": "D", "text": "string" }
      ],
      "correctOption": "A",
      "explanation": "string",
      "distractorAnalysis": {
        "A": "string",
        "B": "string",
        "C": "string",
        "D": "string"
      }
    }
  ]
}
`;

      const model = await getActiveGroqModel(groqKey);
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey.trim()}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: 3500
        })
      });

      if (!groqRes.ok) {
        const err = await groqRes.text();
        return reply.status(500).send({ error: `Groq error: ${err}` });
      }

      const data: any = await groqRes.json();
      const content = JSON.parse(data.choices[0]?.message?.content || "{}");
      return reply.send(content);
    } catch (err: any) {
      server.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to generate quiz" });
    }
  });
};

export default quizRoutes;
