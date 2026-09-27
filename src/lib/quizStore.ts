export interface CachedQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  conceptTested: string;
}

interface QuizSession {
  stepId: string;
  questions: CachedQuestion[];
  createdAt: number;
}

const quizStore = new Map<string, QuizSession>();

export function storeQuizSession(stepId: string, questions: CachedQuestion[]): void {
  quizStore.set(stepId, {
    stepId,
    questions,
    createdAt: Date.now(),
  });
}

export function getQuizSession(stepId: string): CachedQuestion[] | undefined {
  const session = quizStore.get(stepId);
  return session?.questions;
}

export function clearQuizSession(stepId: string): void {
  quizStore.delete(stepId);
}
