import { gradeAttempt } from '../../src/services/learning/quiz';
import { LEARNING_CONFIG } from '../../src/config/learning';

console.log('================================================================');
console.log('T8: DETERMINISTIC GRADING & 70% PASS THRESHOLD VERIFICATION');
console.log(`Configured Pass Threshold: ${LEARNING_CONFIG.PASS_THRESHOLD_PERCENT}%`);
console.log('================================================================\n');

let allPassed = true;

// 1. Table-driven verification across question totals {8, 9, 10, 11, 12}
const totals = [8, 9, 10, 11, 12];

console.log('--- Table-driven Tests over Total Questions {8, 9, 10, 11, 12} ---');
console.log('Total | Correct | Required | Percent | Passed? | Expected Pass');
console.log('------------------------------------------------------------');

for (const total of totals) {
  for (let correct = 0; correct <= total; correct++) {
    // Construct questions
    const questions = Array.from({ length: total }, (_, i) => ({
      id: `q-${i + 1}`,
      chapterKey: `c${(i % 3) + 1}`,
      correctOptionId: `opt-${i}-c`,
    }));

    // Answers dictionary with 'correct' correct answers
    const answers: Record<string, string> = {};
    for (let i = 0; i < correct; i++) {
      answers[`q-${i + 1}`] = `opt-${i}-c`;
    }
    // Remaining are answered wrong
    for (let i = correct; i < total; i++) {
      answers[`q-${i + 1}`] = `opt-${i}-wrong`;
    }

    const res = gradeAttempt(questions, answers, LEARNING_CONFIG.PASS_THRESHOLD_PERCENT);

    // Verify mathematical bounds
    const expectedRequired = Math.ceil((LEARNING_CONFIG.PASS_THRESHOLD_PERCENT * total) / 100);
    const expectedPass = correct >= expectedRequired;

    if (res.requiredCorrect !== expectedRequired || res.passed !== expectedPass) {
      console.error(
        `FAILED for total ${total}, correct ${correct}: expected pass=${expectedPass}, got ${res.passed}`
      );
      allPassed = false;
    }

    // Print specific boundary tests
    if (
      (total === 10 && (correct === 6 || correct === 7)) ||
      (total === 11 && (correct === 7 || correct === 8)) ||
      correct === 0 ||
      correct === total
    ) {
      console.log(
        `${String(total).padStart(5)} | ${String(correct).padStart(7)} | ${String(
          res.requiredCorrect
        ).padStart(8)} | ${String(res.percent).padStart(6)}% | ${String(res.passed).padEnd(
          7
        )} | ${expectedPass}`
      );
    }
  }
}

// 2. Specific Edge Cases: Unanswered questions, unknown question IDs, unknown option IDs
console.log('\n--- Edge Cases Verification ---');

const baseQuestions = [
  { id: 'q-1', chapterKey: 'c1', correctOptionId: 'opt-c1' },
  { id: 'q-2', chapterKey: 'c1', correctOptionId: 'opt-c2' },
  { id: 'q-3', chapterKey: 'c2', correctOptionId: 'opt-c3' },
  { id: 'q-4', chapterKey: 'c2', correctOptionId: 'opt-c4' },
  { id: 'q-5', chapterKey: 'c2', correctOptionId: 'opt-c5' },
  { id: 'q-6', chapterKey: 'c3', correctOptionId: 'opt-c6' },
  { id: 'q-7', chapterKey: 'c3', correctOptionId: 'opt-c7' },
  { id: 'q-8', chapterKey: 'c3', correctOptionId: 'opt-c8' },
  { id: 'q-9', chapterKey: 'c3', correctOptionId: 'opt-c9' },
  { id: 'q-10', chapterKey: 'c3', correctOptionId: 'opt-c10' },
];

// Unanswered test: only 7 questions answered (all 7 correct), 3 left blank
const answersWithBlanks: Record<string, string> = {
  'q-1': 'opt-c1',
  'q-2': 'opt-c2',
  'q-3': 'opt-c3',
  'q-4': 'opt-c4',
  'q-5': 'opt-c5',
  'q-6': 'opt-c6',
  'q-7': 'opt-c7',
  // q-8, q-9, q-10 are omitted (unanswered)
};
const resUnanswered = gradeAttempt(baseQuestions, answersWithBlanks, LEARNING_CONFIG.PASS_THRESHOLD_PERCENT);
console.log(
  `Unanswered Test: 7/10 answered correctly -> Score: ${resUnanswered.percent}%, Correct: ${resUnanswered.correct}/${resUnanswered.total}, Passed: ${resUnanswered.passed} (Required: ${resUnanswered.requiredCorrect})`
);
if (resUnanswered.correct !== 7 || !resUnanswered.passed) {
  console.error('FAILED Unanswered test');
  allPassed = false;
}

// Unknown question ID and unknown option ID injected
const answersWithInjections: Record<string, string> = {
  'q-1': 'opt-c1',
  'q-2': 'opt-c2',
  'q-3': 'opt-c3',
  'q-4': 'opt-c4',
  'q-5': 'opt-c5',
  'q-6': 'opt-c6',
  'q-7': 'UNKNOWN_OPTION_ID', // wrong option id
  'UNKNOWN_QUESTION_ID': 'opt-c1', // should be ignored
};
const resInjected = gradeAttempt(baseQuestions, answersWithInjections, LEARNING_CONFIG.PASS_THRESHOLD_PERCENT);
console.log(
  `Injected Test: 6 correct, 1 invalid opt, 1 unknown question -> Score: ${resInjected.percent}%, Correct: ${resInjected.correct}/${resInjected.total}, Passed: ${resInjected.passed}`
);
if (resInjected.correct !== 6 || resInjected.passed) {
  console.error('FAILED Injected test');
  allPassed = false;
}

// 7/10 passes (70%), 6/10 fails (60%)
const check7of10 = gradeAttempt(baseQuestions, {
  'q-1': 'opt-c1', 'q-2': 'opt-c2', 'q-3': 'opt-c3', 'q-4': 'opt-c4',
  'q-5': 'opt-c5', 'q-6': 'opt-c6', 'q-7': 'opt-c7'
}, 70);
const check6of10 = gradeAttempt(baseQuestions, {
  'q-1': 'opt-c1', 'q-2': 'opt-c2', 'q-3': 'opt-c3', 'q-4': 'opt-c4',
  'q-5': 'opt-c5', 'q-6': 'opt-c6'
}, 70);

console.log(`\nSpecific Verification:`);
console.log(`7/10: score=${check7of10.percent}%, passed=${check7of10.passed} (expected: true)`);
console.log(`6/10: score=${check6of10.percent}%, passed=${check6of10.passed} (expected: false)`);

// 8/11 passes (73%), 7/11 fails (64%)
const questions11 = Array.from({ length: 11 }, (_, i) => ({
  id: `q-${i + 1}`,
  chapterKey: 'c1',
  correctOptionId: `c-${i}`,
}));
const check8of11 = gradeAttempt(questions11, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`q-${i + 1}`, `c-${i}`])), 70);
const check7of11 = gradeAttempt(questions11, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`q-${i + 1}`, `c-${i}`])), 70);

console.log(`8/11: score=${check8of11.percent}%, passed=${check8of11.passed} (expected: true)`);
console.log(`7/11: score=${check7of11.percent}%, passed=${check7of11.passed} (expected: false)`);

if (!check7of10.passed || check6of10.passed || !check8of11.passed || check7of11.passed) {
  allPassed = false;
}

console.log('\n================================================================');
if (allPassed) {
  console.log('✅ ALL T8 GRADING TESTS PASSED WITH 100% ACCURACY');
} else {
  console.error('❌ SOME GRADING TESTS FAILED');
  process.exit(1);
}
console.log('================================================================');
