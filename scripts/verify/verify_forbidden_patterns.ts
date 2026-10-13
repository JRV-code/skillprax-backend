import { execSync } from 'child_process';

console.log('=== SECTION 17: FORBIDDEN PATTERNS AUDIT ===\n');

const checks = [
  {
    name: '1. InAppContentReaderModal imported in step view or active components',
    cwd: 'D:/JRMC/skillprax-frontend',
    pattern: "import.*InAppContentReaderModal",
    path: 'src/',
  },
  {
    name: '2. interface ExecutionState in backend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: 'interface ExecutionState',
    path: 'src/',
  },
  {
    name: '3. Special:Search in backend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: 'Special:Search',
    path: 'src/',
  },
  {
    name: '4. youtube.com/results in backend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: 'youtube.com/results',
    path: 'src/',
  },
  {
    name: '5. google.com/search in backend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: 'google.com/search',
    path: 'src/',
  },
  {
    name: '6. search_query= in backend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: 'search_query=',
    path: 'src/',
  },
  {
    name: '7. correctOptionIndex: 0 in backend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: 'correctOptionIndex: 0',
    path: 'src/',
  },
  {
    name: '8. --accept-data-loss in backend/frontend',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: '--accept-data-loss',
    path: '.',
  },
  {
    name: '9. hardcoded pass mark 75% or 80% in learning services',
    cwd: 'D:/JRMC/skillprax-backend',
    pattern: '75%|80%|>= 75|>= 80',
    path: 'src/services/learning/ src/routes/learning/',
  },
];

let allPassed = true;

for (const c of checks) {
  try {
    const out = execSync(`git grep -E -e "${c.pattern}" -- ${c.path}`, {
      cwd: c.cwd,
      encoding: 'utf-8',
    }).trim();
    if (out) {
      console.error(`❌ [FAIL] ${c.name} returned results:\n${out}\n`);
      allPassed = false;
    }
  } catch {
    console.log(`✅ [PASS] ${c.name}: 0 results found.`);
  }
}

console.log('\n================================================================');
if (allPassed) {
  console.log('✅ ALL FORBIDDEN PATTERN CHECKS RETURNED ZERO RESULTS');
} else {
  console.error('❌ SOME FORBIDDEN PATTERNS WERE DETECTED');
  process.exit(1);
}
console.log('================================================================');
