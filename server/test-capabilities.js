#!/usr/bin/env node
/**
 * test-capabilities.js — Integration test for GET /api/capabilities
 *
 * Tests the capabilities discovery endpoint by calling the builder
 * functions directly and verifying response shape + content.
 *
 * Usage: node server/test-capabilities.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { buildCapabilities, discoverProviders, listStepTypes, _resetCaches } = require('./routes/discovery');
const { STEP_OBJECTIVES, STEP_DEFAULT_CONTRACTS } = require('./context-compiler');
const { DEFAULT_CONTROLS, DEFAULT_STEP_PIPELINE } = require('./management');

// Reset caches before test
_resetCaches();

// --- Mock deps and helpers ---
const mockRuntimes = {
  openclaw: {
    dispatch() {},
    extractReplyText() {},
    extractSessionId() {},
    extractUsage() {},
    capabilities() {
      return { runtime: 'openclaw', supportsReview: true, supportsSessionResume: true };
    },
  },
  opencode: {
    dispatch() {},
    extractReplyText() {},
    extractSessionId() {},
    extractUsage() {},
    capabilities() {
      return { runtime: 'opencode', supportsSessionResume: true, supportsModelSelection: true };
    },
  },
};

const mockDeps = {
  RUNTIMES: mockRuntimes,
  ctx: { dir: path.resolve(__dirname, '..') },
};

const mockHelpers = {
  readBoard() {
    return {
      controls: {
        model_map: {
          opencode: { plan: 'custom-ai-t8star-cn/gpt-5.3-codex-high', default: 'custom-ai-t8star-cn/gpt-5.3-codex-high' },
        },
      },
    };
  },
};

console.log('=== Capabilities Discovery Test ===\n');

// --- Test 1: buildCapabilities returns correct shape ---
const result = buildCapabilities(mockDeps, mockHelpers);

assert.ok(Array.isArray(result.runtimes), 'runtimes should be an array');
assert.ok(Array.isArray(result.stepTypes), 'stepTypes should be an array');
assert.ok(typeof result.models === 'object', 'models should be an object');
assert.ok(Array.isArray(result.providers), 'providers should be an array');
assert.ok(Array.isArray(result.defaultPipeline), 'defaultPipeline should be an array');
console.log('  \u2705 Response shape is correct');

// --- Test 2: Runtimes contain expected fields ---
assert.strictEqual(result.runtimes.length, 2);
for (const rt of result.runtimes) {
  assert.ok(rt.id, 'runtime should have id');
  assert.strictEqual(rt.installed, true, 'registered runtimes should be installed');
  assert.ok(typeof rt.capabilities === 'object', 'runtime should have capabilities object');
}
const ids = result.runtimes.map(r => r.id);
assert.ok(ids.includes('openclaw'), 'should include openclaw');
assert.ok(ids.includes('opencode'), 'should include opencode');
console.log('  \u2705 Runtimes have correct structure and IDs');

// --- Test 3: Runtime capabilities are fully passed through ---
const openclaw = result.runtimes.find(r => r.id === 'openclaw');
assert.strictEqual(openclaw.capabilities.supportsReview, true);
assert.strictEqual(openclaw.capabilities.supportsSessionResume, true);
const opencode = result.runtimes.find(r => r.id === 'opencode');
assert.strictEqual(opencode.capabilities.supportsModelSelection, true);
console.log('  \u2705 Runtime capabilities are passed through');

// --- Test 4: Step types include core types ---
const stepTypeNames = result.stepTypes.map(s => s.type);
assert.ok(stepTypeNames.includes('plan'), 'should include plan step type');
assert.ok(stepTypeNames.includes('implement'), 'should include implement step type');
assert.ok(stepTypeNames.includes('review'), 'should include review step type');
assert.ok(stepTypeNames.includes('execute'), 'should include execute step type');
console.log('  \u2705 Step types include core types');

// --- Test 5: Step types have all required fields ---
for (const st of result.stepTypes) {
  assert.ok(st.type, 'step type should have type');
  assert.ok(typeof st.objective === 'string', 'step type should have objective string');
  assert.ok(typeof st.defaultTimeoutSec === 'number', 'step type should have defaultTimeoutSec number');
}
// implement should have a contract
const implementStep = result.stepTypes.find(s => s.type === 'implement');
assert.deepStrictEqual(implementStep.contract, { deliverable: 'pr' });
console.log('  \u2705 Step types have all required fields');

// --- Test 6: Models from controls ---
assert.strictEqual(result.models.source, 'controls.model_map');
assert.ok(result.models.configured.opencode, 'should have opencode model config');
assert.strictEqual(result.models.configured.opencode.plan, 'custom-ai-t8star-cn/gpt-5.3-codex-high');
console.log('  \u2705 Models reflect controls.model_map');

// --- Test 7: Providers include anthropic (implicit) ---
const anthropic = result.providers.find(p => p.id === 'anthropic');
assert.ok(anthropic, 'should include anthropic provider');
assert.ok(anthropic.runtimes.includes('openclaw'), 'anthropic should list openclaw runtime');
assert.ok(anthropic.runtimes.includes('claude'), 'anthropic should list claude runtime');
console.log('  \u2705 Implicit anthropic provider present');

// --- Test 8: Providers include opencode.json providers ---
const t8star = result.providers.find(p => p.id === 'custom-ai-t8star-cn');
assert.ok(t8star, 'should include T8Star provider from opencode.json');
assert.strictEqual(t8star.name, 'T8Star AI');
assert.ok(t8star.models.includes('gpt-5.3-codex-high'), 'T8Star should list its models');
assert.ok(t8star.runtimes.includes('opencode'), 'T8Star should list opencode runtime');
console.log('  \u2705 opencode.json providers discovered');

// --- Test 9: Default pipeline ---
assert.ok(result.defaultPipeline.includes('plan'), 'default pipeline should include plan');
assert.ok(result.defaultPipeline.includes('implement'), 'default pipeline should include implement');
assert.ok(result.defaultPipeline.includes('review'), 'default pipeline should include review');
console.log('  \u2705 Default pipeline included');

// --- Test 10: listStepTypes standalone ---
_resetCaches();
const stepTypes = listStepTypes();
assert.ok(stepTypes.length >= 4, 'should have at least 4 step types');
const planStep = stepTypes.find(s => s.type === 'plan');
assert.strictEqual(planStep.defaultTimeoutSec, 300);
console.log('  \u2705 listStepTypes works standalone');

// --- Test 11: discoverProviders standalone ---
_resetCaches();
const providers = discoverProviders(path.resolve(__dirname, '..'));
assert.ok(providers.length >= 1, 'should have at least 1 provider');
assert.strictEqual(providers[0].id, 'anthropic');
console.log('  \u2705 discoverProviders works standalone');

// --- Snapshot comparison ---
// Write a shape snapshot for future regression detection
const fs = require('fs');
const snapshotDir = path.join(__dirname, '..', '.tmp');
if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });

const snapshot = {
  runtimeIds: result.runtimes.map(r => r.id).sort(),
  stepTypes: result.stepTypes.map(s => s.type).sort(),
  providerIds: result.providers.map(p => p.id).sort(),
  defaultPipeline: result.defaultPipeline,
  hasModels: Object.keys(result.models.configured).length > 0,
};
fs.writeFileSync(path.join(snapshotDir, 'capabilities-snapshot.json'), JSON.stringify(snapshot, null, 2));
console.log('  \u2705 Snapshot written to .tmp/capabilities-snapshot.json');

console.log('\n\u2705 All 11 tests passed.');
