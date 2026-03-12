'use strict';
/**
 * test-marketplace.js — Tests for skill marketplace endpoints
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const marketplace = require('./routes/marketplace');
const semver = require('./routes/_semver');

const TEST_DIR = path.join(__dirname, 'skills');
const TEST_SKILL_DIR = path.join(TEST_DIR, 'test-skill');
const TEST_MANIFEST = path.join(TEST_SKILL_DIR, 'manifest.json');

function setup() {
  fs.mkdirSync(TEST_SKILL_DIR, { recursive: true });
  fs.writeFileSync(TEST_MANIFEST, JSON.stringify({
    name: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    tags: ['test', 'demo'],
    author: 'test',
  }));
  fs.writeFileSync(path.join(TEST_SKILL_DIR, 'SKILL.md'), '# Test Skill\n\nTest description.');
  marketplace._resetCache();
}

function teardown() {
  fs.rmSync(TEST_SKILL_DIR, { recursive: true, force: true });
  marketplace._resetCache();
}

function testListMarketplaceSkills() {
  setup();
  try {
    const skills = marketplace.listMarketplaceSkills();
    const testSkill = skills.find(s => s.id === 'test-skill');
    assert.ok(testSkill, 'test-skill should be listed');
    assert.strictEqual(testSkill.name, 'Test Skill');
    assert.strictEqual(testSkill.version, '1.0.0');
    assert.deepStrictEqual(testSkill.tags, ['test', 'demo']);
    console.log('✓ listMarketplaceSkills returns skills with manifest');
  } finally {
    teardown();
  }
}

function testGetSkillDetail() {
  setup();
  try {
    const detail = marketplace.getSkillDetail('test-skill');
    assert.ok(detail, 'skill detail should exist');
    assert.strictEqual(detail.name, 'Test Skill');
    assert.ok(detail.files.includes('manifest.json'), 'files should include manifest.json');
    assert.ok(detail.files.includes('SKILL.md'), 'files should include SKILL.md');
    assert.ok(detail.readme.includes('# Test Skill'), 'readme should be loaded');
    console.log('✓ getSkillDetail returns full skill info');
  } finally {
    teardown();
  }
}

function testGetSkillDetailNotFound() {
  const detail = marketplace.getSkillDetail('nonexistent-skill');
  assert.strictEqual(detail, null);
  console.log('✓ getSkillDetail returns null for nonexistent skill');
}

function testSemverValid() {
  assert.strictEqual(semver.valid('1.0.0'), true);
  assert.strictEqual(semver.valid('2.3.4'), true);
  assert.strictEqual(semver.valid('1.0.0-alpha'), true);
  assert.strictEqual(semver.valid('1.0.0+build'), true);
  assert.strictEqual(semver.valid('invalid'), false);
  assert.strictEqual(semver.valid('1.0'), false);
  console.log('✓ semver.valid works correctly');
}

function testSemverCompare() {
  assert.strictEqual(semver.compare('1.0.0', '1.0.0'), 0);
  assert.strictEqual(semver.compare('1.0.1', '1.0.0'), 1);
  assert.strictEqual(semver.compare('1.0.0', '1.0.1'), -1);
  assert.strictEqual(semver.compare('2.0.0', '1.9.9'), 1);
  assert.strictEqual(semver.compare('1.2.3', '1.3.0'), -1);
  console.log('✓ semver.compare works correctly');
}

function testSemverGtLt() {
  assert.strictEqual(semver.gt('1.0.1', '1.0.0'), true);
  assert.strictEqual(semver.gt('1.0.0', '1.0.1'), false);
  assert.strictEqual(semver.lt('1.0.0', '1.0.1'), true);
  assert.strictEqual(semver.lt('1.0.1', '1.0.0'), false);
  assert.strictEqual(semver.gte('1.0.0', '1.0.0'), true);
  assert.strictEqual(semver.lte('1.0.0', '1.0.0'), true);
  console.log('✓ semver gt/lt/gte/lte work correctly');
}

function testSemverPrerelease() {
  assert.strictEqual(semver.compare('1.0.0', '1.0.0-alpha'), 1);
  assert.strictEqual(semver.compare('1.0.0-alpha', '1.0.0'), -1);
  assert.strictEqual(semver.compare('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
  console.log('✓ semver handles prerelease versions');
}

function testSemverSatisfies() {
  assert.strictEqual(semver.satisfies('1.2.3', '^1.0.0'), true);
  assert.strictEqual(semver.satisfies('2.0.0', '^1.0.0'), false);
  assert.strictEqual(semver.satisfies('1.2.3', '~1.2.0'), true);
  assert.strictEqual(semver.satisfies('1.3.0', '~1.2.0'), false);
  assert.strictEqual(semver.satisfies('1.0.0', '>=1.0.0'), true);
  assert.strictEqual(semver.satisfies('0.9.0', '>=1.0.0'), false);
  console.log('✓ semver.satisfies handles ranges');
}

function testSemverInc() {
  assert.strictEqual(semver.inc('1.2.3', 'major'), '2.0.0');
  assert.strictEqual(semver.inc('1.2.3', 'minor'), '1.3.0');
  assert.strictEqual(semver.inc('1.2.3', 'patch'), '1.2.4');
  console.log('✓ semver.inc works correctly');
}

function testManifestWithoutVersion() {
  setup();
  try {
    fs.writeFileSync(TEST_MANIFEST, JSON.stringify({ name: 'NoVersion' }));
    marketplace._resetCache();
    const skills = marketplace.listMarketplaceSkills();
    const testSkill = skills.find(s => s.id === 'test-skill');
    assert.strictEqual(testSkill, undefined, 'skill without version should be skipped');
    console.log('✓ skills without version in manifest are skipped');
  } finally {
    teardown();
  }
}

function testManifestWithoutName() {
  setup();
  try {
    fs.writeFileSync(TEST_MANIFEST, JSON.stringify({ version: '1.0.0' }));
    marketplace._resetCache();
    const skills = marketplace.listMarketplaceSkills();
    const testSkill = skills.find(s => s.id === 'test-skill');
    assert.strictEqual(testSkill, undefined, 'skill without name should be skipped');
    console.log('✓ skills without name in manifest are skipped');
  } finally {
    teardown();
  }
}

function testInvalidManifestJson() {
  setup();
  try {
    fs.writeFileSync(TEST_MANIFEST, 'not valid json');
    marketplace._resetCache();
    const skills = marketplace.listMarketplaceSkills();
    const testSkill = skills.find(s => s.id === 'test-skill');
    assert.strictEqual(testSkill, undefined, 'skill with invalid JSON should be skipped');
    console.log('✓ skills with invalid manifest JSON are skipped');
  } finally {
    teardown();
  }
}

function runTests() {
  console.log('Running marketplace tests...\n');

  testListMarketplaceSkills();
  testGetSkillDetail();
  testGetSkillDetailNotFound();
  testManifestWithoutVersion();
  testManifestWithoutName();
  testInvalidManifestJson();

  console.log('\nRunning semver tests...\n');

  testSemverValid();
  testSemverCompare();
  testSemverGtLt();
  testSemverPrerelease();
  testSemverSatisfies();
  testSemverInc();

  console.log('\n✅ All tests passed!');
}

runTests();
