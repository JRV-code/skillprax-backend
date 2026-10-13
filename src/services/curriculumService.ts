import {
  estimateDynamicCurriculum,
  researchAndSynthesizeStepContent,
  DynamicCurriculumResult,
  StepPlanItem,
  StepSynthesizedContent,
} from './aiOrchestrator';
import {
  fetchAndSynthesizeStepDocumentation,
  generateStepDocumentationAndQuiz,
  getDifficultyTier,
  DifficultyTier,
  StepDocParams,
  DocumentationResult,
} from './documentationService';
import {
  fetchVerifiedStepVideos,
  fetchVerifiedStepVideo,
  VerifiedStepVideo,
} from './videoService';

export {
  estimateDynamicCurriculum,
  researchAndSynthesizeStepContent,
  fetchAndSynthesizeStepDocumentation,
  generateStepDocumentationAndQuiz,
  getDifficultyTier,
  fetchVerifiedStepVideos,
  fetchVerifiedStepVideo,
};

export type {
  DynamicCurriculumResult,
  StepPlanItem,
  StepSynthesizedContent,
  DifficultyTier,
  StepDocParams,
  DocumentationResult,
  VerifiedStepVideo,
};

export default {
  estimateDynamicCurriculum,
  researchAndSynthesizeStepContent,
  fetchAndSynthesizeStepDocumentation,
  generateStepDocumentationAndQuiz,
  getDifficultyTier,
  fetchVerifiedStepVideos,
  fetchVerifiedStepVideo,
};
