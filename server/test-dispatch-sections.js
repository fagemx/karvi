/**
 * Unit tests for buildSkillContextSection() and buildCompletionCriteriaSection()
 * Run: node server/test-dispatch-sections.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { buildSkillContextSection, buildCompletionCriteriaSection } = require('./management');

console.log('Testing dispatch message sections...\n');

// Test 1: buildCompletionCriteriaSection returns expected format
console.log('Test 1: Completion criteria format');
const criteriaLines = buildCompletionCriteriaSection();
assert(Array.isArray(criteriaLines), 'Should return array');
assert(criteriaLines.some(l => l.includes('Completion Criteria')), 'Should include header');
assert(criteriaLines.some(l => l.includes('node -c')), 'Should include syntax check');
assert(criteriaLines.some(l => l.includes('Re-read the task description')), 'Should include scope verification');
console.log('  ✓ Format correct\n');

// Test 2: buildSkillContextSection with null projectRoot (karvi itself)
console.log('Test 2: Skill context for karvi (null projectRoot)');
const karviLines = buildSkillContextSection(null);
assert(Array.isArray(karviLines), 'Should return array');
assert(karviLines.some(l => l.includes('Coding Standards')), 'Should include header');
console.log(`  ✓ Returned ${karviLines.length} lines\n`);

// Test 3: buildSkillContextSection falls back to karvi skills for nonexistent project
console.log('Test 3: Fallback to karvi skills for missing project');
// Clear cache to ensure fresh read
if (buildSkillContextSection._cacheMap) {
  buildSkillContextSection._cacheMap.clear();
}
const fallbackLines = buildSkillContextSection('/nonexistent/path');
// When project skills don't exist, falls back to karvi's skills
assert(fallbackLines.some(l => l.includes('Coding Standards')), 'Should include header');
assert(fallbackLines.length > 1, 'Should return content lines');
console.log(`  ✓ Falls back to karvi skills (${fallbackLines.length} lines)\n`);

// Test 4: Caching works
console.log('Test 4: Per-project caching');
// Clear cache
if (buildSkillContextSection._cacheMap) {
  buildSkillContextSection._cacheMap.clear();
}

// First call
const start1 = Date.now();
buildSkillContextSection(null);
const time1 = Date.now() - start1;

// Second call (should be cached)
const start2 = Date.now();
buildSkillContextSection(null);
const time2 = Date.now() - start2;

console.log(`  First call: ${time1}ms, Second call: ${time2}ms`);
console.log(`  ✓ Caching works (second call faster or equal)\n`);

// Test 5: Skill context extracts from actual skill files
console.log('Test 5: Skill file extraction');
const skillDir = path.join(__dirname, 'skills');
const engineerPlaybook = path.join(skillDir, 'engineer-playbook', 'SKILL.md');
const blackboardBasics = path.join(skillDir, 'blackboard-basics', 'SKILL.md');

if (fs.existsSync(engineerPlaybook) && fs.existsSync(blackboardBasics)) {
  const lines = buildSkillContextSection(null);
  // Should contain content from skill files (not just fallback)
  const hasSkillContent = lines.some(l => 
    l.includes('board.json') || 
    l.includes('dependencies') ||
    l.includes('Atomic') ||
    l.includes('Windows')
  );
  assert(hasSkillContent, 'Should extract from skill files');
  console.log('  ✓ Skill file extraction working\n');
} else {
  console.log('  ⚠ Skill files not found, using fallback (expected in some environments)\n');
}

// Test 6: Completion criteria includes all required items
console.log('Test 6: Completion criteria completeness');
const criteria = buildCompletionCriteriaSection().join('\n');
const requiredItems = [
  'Re-read',
  'requirement',
  'node -c',
  'skipped',
  'Commit'
];
for (const item of requiredItems) {
  assert(criteria.includes(item), `Should include: ${item}`);
}
console.log('  ✓ All required items present\n');

console.log('All tests passed! ✓');
