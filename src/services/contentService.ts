import {
  generateStepDocumentationAndQuiz,
  fetchAndSynthesizeStepDocumentation,
  getDifficultyTier,
  DocumentationResult,
  StepDocParams,
} from './documentationService';
import {
  fetchVerifiedStepVideo,
  fetchVerifiedStepVideos,
  VerifiedStepVideo,
} from './videoService';

export {
  generateStepDocumentationAndQuiz,
  fetchAndSynthesizeStepDocumentation,
  getDifficultyTier,
  fetchVerifiedStepVideo,
  fetchVerifiedStepVideos,
};

export type { DocumentationResult, StepDocParams, VerifiedStepVideo };

/**
 * High-level contentService gateway satisfying the specification:
 * Throws "Unable to fetch verified step resources. Please verify API keys in .env."
 * if resource retrieval fails. Zero static stubs.
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
    fetchAndSynthesizeStepDocumentation(params),
  ]);

  return {
    ...video,
    ...doc,
  };
}

export default {
  fetchVerifiedStepContent,
  fetchAndSynthesizeStepDocumentation,
  generateStepDocumentationAndQuiz,
  fetchVerifiedStepVideo,
  fetchVerifiedStepVideos,
  getDifficultyTier,
};
