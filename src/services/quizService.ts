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
    model: 'llama-3.1-70b-versatile',
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

export async function evaluateQuizSubmission(
  userId: string,
  skillId: string,
  stepNumber: number,
  answers: number[]
) {
  const stepRes = await db.query(
    'SELECT quiz_data FROM skill_steps WHERE skill_id = $1 AND step_number = $2',
    [skillId, stepNumber]
  );

  if (stepRes.rows.length === 0) {
    throw new Error(`Step ${stepNumber} not found for skill ${skillId}`);
  }

  let questions = stepRes.rows[0].quiz_data || [];
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch (_) {
      questions = [];
    }
  }

  let correctCount = 0;
  const breakdown = questions.map((q: any, idx: number) => {
    const isCorrect = q.correctOptionIndex === answers[idx];
    if (isCorrect) correctCount++;
    return {
      questionId: q.id || `q${idx + 1}`,
      isCorrect,
      explanation: q.explanation || '',
    };
  });

  // Calculate score percentage
  const total = Math.max(questions.length, 1);
  const scorePercentage = Math.round((correctCount / total) * 100);

  // STRICT 70% PASSING CRITERIA
  const passed = scorePercentage >= 70;

  if (passed) {
    // 1. Mark current step as completed and quiz passed
    await db.query(
      `UPDATE skill_steps 
       SET is_completed = TRUE, quiz_passed = TRUE, quiz_score = $1 
       WHERE skill_id = $2 AND step_number = $3`,
      [scorePercentage, skillId, stepNumber]
    );

    // 2. Unlock next step (Step N + 1)
    await db.query(
      `UPDATE skill_steps 
       SET is_unlocked = TRUE 
       WHERE skill_id = $1 AND step_number = $2`,
      [skillId, stepNumber + 1]
    );

    // 3. Award learner XP points
    try {
      await db.query(
        `UPDATE users SET xp = COALESCE(xp, 0) + 150 WHERE id = $1`,
        [userId]
      );
    } catch (_) {
      try {
        await db.query(
          `UPDATE users SET xp_points = COALESCE(xp_points, 0) + 150 WHERE id = $1`,
          [userId]
        );
      } catch (_) {}
    }
  }

  return {
    scorePercentage,
    passed,
    passingThreshold: 70,
    breakdown,
  };
}

export const evaluateQuiz = evaluateQuizSubmission;

export default {
  generateStepQuiz,
  evaluateQuizSubmission,
  evaluateQuiz,
};
