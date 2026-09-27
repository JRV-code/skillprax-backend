import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma';
import { safeJsonParse } from '../lib/ai/orchestrator';
import { storeQuizSession } from '../lib/quizStore';

export async function quizRoutes(fastify: FastifyInstance) {
  fastify.post('/api/quizzes/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { stepId } = (request.body || {}) as { stepId: string };
    if (!stepId) {
      return reply.status(400).send({ error: 'stepId is required' });
    }

    const step = await prisma.skillStep.findUnique({
      where: { id: stepId },
      include: { workspace: true },
    });

    if (!step) {
      return reply.status(404).send({ error: 'Step not found' });
    }

    const questionCount = step.questionCount || 5;
    const assessableUnits = safeJsonParse<string[]>(step.assessableUnits, []);
    const coreKeyTakeaways = safeJsonParse<string[]>(step.coreKeyTakeaways, []);

    const config = await prisma.adminConfig.findFirst();
    const groqKey = config?.groqKey || process.env.GROQ_API_KEY || '';

    const quizPrompt = `
Generate a scenario-based diagnostic evaluation quiz for Step: "${step.title}".
Subject: "${step.workspace.title}".
Core Concepts: ${JSON.stringify(coreKeyTakeaways)}.
Assessable Competency Units: ${JSON.stringify(assessableUnits)}.

REQUIREMENTS:
Generate exactly ${questionCount} scenario-based diagnostic questions in valid json format (each mapped to one assessable competency unit).
Each question must present a realistic challenge, edge case, or trade-off scenario with 4 options (A, B, C, D).
Provide a clear explanation for the correct answer, and actionable distractor analysis explaining the misconception behind each incorrect option.
Output as a valid JSON object with a "questions" array schema:
{
  "questions": [
    {
      "id": "q1",
      "question": "...",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "conceptTested": "...",
      "explanation": "..."
    }
  ]
}`;

    const systemPrompt = `You are a world-class technical mentor. You MUST return your output strictly as a valid JSON object matching the requested schema.`;

    let questions: any[] = [];
    if (groqKey) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqKey.trim()}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: quizPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 3500
          })
        });
        if (groqRes.ok) {
          const groqData: any = await groqRes.json();
          const rawContent = groqData.choices[0]?.message?.content || '{}';
          const parsed = JSON.parse(rawContent);
          questions = parsed.questions || [];
        }
      } catch (err: any) {
        console.warn('Groq quiz fetch warning:', err.message);
      }
    }

    if (!questions || questions.length === 0) {
      const { generateQuizQuestions } = await import('../lib/ai/orchestrator');
      const fallback = await generateQuizQuestions(
        step.title,
        step.whatYouWillLearn || step.title,
        step.difficulty,
        questionCount,
        step.workspace.aiProvider || 'groq'
      );
      questions = fallback.questions || [];
    }

    storeQuizSession(stepId, questions);

    const sanitizedQuestions = questions.map(({ correctIndex, ...q }: any) => {
      let options = q.options;
      if (Array.isArray(options) && options.length > 0 && typeof options[0] === 'object' && options[0].text) {
        options = options.map((opt: any) => opt.text);
      }
      let cIndex = q.correctIndex;
      if (typeof cIndex === 'string') {
        const mapKey: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, a: 0, b: 1, c: 2, d: 3 };
        cIndex = mapKey[cIndex] ?? 0;
      }
      return {
        ...q,
        options,
        correctIndex: cIndex,
      };
    }).map(({ correctIndex, ...q }: any) => q);

    return reply.send({
      stepId,
      questionCount,
      questions: sanitizedQuestions,
    });
  });
}

export default quizRoutes;
