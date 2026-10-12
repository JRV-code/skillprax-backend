import { generateStepDocumentationAndQuiz, DocumentationResult } from './documentationService';
import { fetchVerifiedStepVideo } from './videoService';

export {
  generateStepDocumentationAndQuiz,
  fetchVerifiedStepVideo,
};

export type { DocumentationResult };

/**
 * High-level contentService gateway satisfying the specification:
 * Throws "Unable to fetch verified step resources. Please verify API keys in .env."
 * if resource retrieval fails, ensuring zero mock swimming fallbacks.
 */
export async function fetchVerifiedStepContent(params: {
  userId?: string;
  skillId?: string;
  skillName: string;
  subGenre?: string;
  skillCategory?: 'cognitive' | 'physical';
  stepNumber: number;
  totalSteps?: number;
  stepTitle: string;
  stepDescription?: string;
  masteryLevel?: string;
  preferredLanguage?: string;
}) {
  const [video, doc] = await Promise.all([
    fetchVerifiedStepVideo({
      userId: params.userId,
      skillId: params.skillId,
      skillName: params.skillName,
      subGenre: params.subGenre,
      stepNumber: params.stepNumber,
      stepTitle: params.stepTitle,
      skillCategory: params.skillCategory,
    }),
    generateStepDocumentationAndQuiz(params),
  ]);

  return {
    ...video,
    ...doc,
  };
}
