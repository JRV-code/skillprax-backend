import { groq } from '../lib/groqClient';
import { db } from '../lib/db';

export async function generateStepQuiz(userId: string, skillId: string, stepNumber: number) {
  const stepQuery = await db.query(
    `SELECT s.*, u.skill_name FROM skill_steps s JOIN user_skills u ON s.skill_id = u.id WHERE s.skill_id = $1 AND s.step_number = $2`,
    [skillId, stepNumber]
  );
  let step = stepQuery.rows[0];

  if (!step) {
    const rawQuery = await db.query(
      `SELECT * FROM skill_steps WHERE skill_id = $1 AND step_number = $2`,
      [skillId, stepNumber]
    );
    step = rawQuery.rows[0];
  }

  const topicsPayload = JSON.stringify(step?.topics || [], null, 2);

  const prompt = `You are an Academic Examiner.
Skill: "${step?.skill_name || 'Technical Domain'}" | Step ${stepNumber}: "${step?.title || `Step ${stepNumber}`}" (${step?.difficulty_tier || 'FOUNDATIONS'}).

GROUND TRUTH SOURCED MATERIAL:
${topicsPayload}

Generate EXACTLY 9 Multiple Choice Questions derived directly from this material.
- Questions must test the mechanics, principles, and traps described in these topics.
- Distribute correct answer keys evenly across indices 0 (A), 1 (B), 2 (C), and 3 (D).
- No generic questions.

Return strictly JSON:
{
  "questions": [
    {
      "id": "q1",
      "question": "string",
      "options": ["A", "B", "C", "D"],
      "correctOptionIndex": 1,
      "explanation": "string"
    }
  ]
}`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'You output strictly valid JSON.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.25,
  });

  const parsed = JSON.parse(completion.choices[0].message.content || '{}');

  await db.query(
    'UPDATE skill_steps SET quiz_data = $1 WHERE skill_id = $2 AND step_number = $3',
    [JSON.stringify(parsed.questions || []), skillId, stepNumber]
  );

  return parsed.questions || [];
}

export default {
  generateStepQuiz,
};
