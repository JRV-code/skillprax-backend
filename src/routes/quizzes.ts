import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { PrismaClient } from "@prisma/client";
import { getActiveGroqModel } from "../lib/ai/pipeline";

const prisma = new PrismaClient();

const quizRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // 1. Unified Route: Generate Diagnostic Quiz for a Step
  server.post("/api/steps/:stepId/prompt-quiz", async (req, reply) => {
    try {
      const { stepId } = req.params as { stepId: string };

      const step: any = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true }
      });

      if (!step) {
        return reply.status(404).send({ error: `Step "${stepId}" not found.` });
      }

      const config = await prisma.adminConfig.findFirst();
      const groqKey = config?.groqKey || process.env.GROQ_API_KEY;

      if (!groqKey) {
        return reply.status(400).send({ error: "Groq API key is not configured in Admin." });
      }

      // Sizing is controlled by the step's questionCount (calibrated by Groq)
      const questionCount = step.questionCount || 5;
      const model = await getActiveGroqModel(groqKey);

      const systemPrompt = `You are a diagnostic evaluation examiner. You must return your output strictly as a valid JSON object matching the requested schema. No markdown fences, no conversational prose.`;

      const userPrompt = `
Generate a scenario-based diagnostic evaluation quiz for Step: "${step.title}".
Learning Track: "${step.workspace?.title || step.workspace?.skillName || "Skill Track"}".
Core Key Takeaways: ${JSON.stringify(step.coreKeyTakeaways || step.keyTakeaways || [])}.
Assessable Competency Units: ${JSON.stringify(step.assessableUnits || [])}.

REQUIREMENTS:
1. Generate exactly ${questionCount} scenario-based multiple choice questions.
2. Every question must test a concrete mechanism, edge case, or trade-off.
3. Provide 4 options (A, B, C, D) for each question.
4. For each question, explain why the correct option is right, and provide diagnostic feedback for why each incorrect option is wrong.

JSON SCHEMA:
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

      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey.trim()}`
        },
        body: JSON.stringify({
          model,
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
        const errText = await groqRes.text();
        return reply.status(500).send({ error: `Groq error: ${errText}` });
      }

      const groqData: any = await groqRes.json();
      const content = JSON.parse(groqData.choices[0]?.message?.content || "{}");

      return reply.send(content);
    } catch (err: any) {
      server.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to generate quiz" });
    }
  });

  // 2. Submit Quiz Attempt & Evaluate Passing Threshold
  server.post("/api/steps/:stepId/submit-quiz", async (req, reply) => {
    try {
      const { stepId } = req.params as { stepId: string };
      const { answers, questions } = (req.body || {}) as { answers: Record<string, string>; questions: any[] };

      const step = await prisma.skillStep.findUnique({
        where: { id: stepId },
        include: { workspace: true }
      });

      if (!step) {
        return reply.status(404).send({ error: "Step not found" });
      }

      // Calculate score
      let correctCount = 0;
      const totalQuestions = questions?.length || 1;

      for (const q of questions || []) {
        if (answers[q.id] === q.correctOption) {
          correctCount++;
        }
      }

      const scorePercentage = Math.round((correctCount / totalQuestions) * 100);
      const passed = scorePercentage >= (step.passingScore || 80);

      // Record Attempt
      const attemptData: any = {
        stepId: step.id,
        score: scorePercentage,
        passed,
        answers: answers || {}
      };

      const attempt = await prisma.quizAttempt.create({
        data: attemptData
      });

      // Update Step Status if passed
      if (passed) {
        await prisma.skillStep.update({
          where: { id: step.id },
          data: { status: "PASSED" }
        });
      }

      return reply.send({
        attemptId: attempt.id,
        score: scorePercentage,
        passed,
        passingScore: step.passingScore || 80,
        correctCount,
        totalQuestions
      });
    } catch (err: any) {
      server.log.error(err);
      return reply.status(500).send({ error: err.message || "Failed to submit quiz" });
    }
  });
};

export default quizRoutes;
