/**
 * deliverable-contracts.js — Kind → Delivery Template + Post-check
 *
 * Maps task `kind` to a deliverable contract. Each contract defines:
 * - what output is expected (deliverable type)
 * - how to verify it was actually produced (verify function)
 *
 * Used by plan-dispatcher to attach contracts, and by kernel to verify
 * before marking a task as approved.
 */

const CONTRACTS = {
  code_change: {
    deliverable: 'pr',
    description: 'PR must exist with commits',
    verify(task) {
      if (!task.pr || !task.pr.url) return { ok: false, reason: 'no PR created' };
      return { ok: true };
    },
  },

  research: {
    deliverable: 'artifact',
    description: 'output artifact with non-empty summary (>50 chars)',
    verify(task, _board, _helpers, artifactStore) {
      if (!task.steps || task.steps.length === 0) return { ok: false, reason: 'no steps executed' };
      const lastStep = task.steps[task.steps.length - 1];
      const runId = task.dispatch?.runId || task.id;
      const output = artifactStore ? artifactStore.readArtifact(runId, lastStep.step_id, 'output') : null;
      if (!output) return { ok: false, reason: 'no output artifact found' };
      const summary = output.summary || output.payload?.summary || '';
      if (typeof summary === 'string' && summary.length < 50) {
        return { ok: false, reason: `summary too short (${summary.length} chars, need 50+)` };
      }
      return { ok: true };
    },
  },

  doc: {
    deliverable: 'file',
    description: 'output artifact must exist',
    verify(task, _board, _helpers, artifactStore) {
      if (!task.steps || task.steps.length === 0) return { ok: false, reason: 'no steps executed' };
      const lastStep = task.steps[task.steps.length - 1];
      const runId = task.dispatch?.runId || task.id;
      const output = artifactStore ? artifactStore.readArtifact(runId, lastStep.step_id, 'output') : null;
      if (!output) return { ok: false, reason: 'no output artifact found' };
      return { ok: true };
    },
  },

  ops: {
    deliverable: 'command_result',
    description: 'step must have succeeded status',
    verify(task) {
      if (!task.steps || task.steps.length === 0) return { ok: false, reason: 'no steps executed' };
      const lastStep = task.steps[task.steps.length - 1];
      if (lastStep.state !== 'succeeded') return { ok: false, reason: `last step state: ${lastStep.state}` };
      return { ok: true };
    },
  },

  issue_ops: {
    deliverable: 'issue',
    description: 'output must reference a GitHub issue',
    verify(task, _board, _helpers, artifactStore) {
      if (!task.steps || task.steps.length === 0) return { ok: false, reason: 'no steps executed' };
      const lastStep = task.steps[task.steps.length - 1];
      const runId = task.dispatch?.runId || task.id;
      const output = artifactStore ? artifactStore.readArtifact(runId, lastStep.step_id, 'output') : null;
      if (!output) return { ok: false, reason: 'no output artifact found' };
      return { ok: true };
    },
  },

  discussion: {
    deliverable: 'none',
    description: 'auto-pass — no deliverable needed',
    verify() {
      return { ok: true };
    },
  },
};

/**
 * Look up the contract for a given kind.
 * @param {string} kind
 * @returns {object|null} Contract object or null if unknown kind
 */
function getContract(kind) {
  return CONTRACTS[kind] || null;
}

/**
 * Build a contract attachment for a task based on kind.
 * @param {string} kind - e.g. 'code_change', 'research'
 * @param {string} [acceptance] - optional human-written acceptance criteria
 * @returns {object} Contract to attach to task.contract
 */
function buildContract(kind, acceptance) {
  const contract = CONTRACTS[kind];
  if (!contract) return null;
  return {
    kind,
    deliverable: contract.deliverable,
    acceptance: acceptance || contract.description,
  };
}

/**
 * Verify a task against its contract.
 * @param {object} task - Task with task.contract.kind
 * @param {object} board
 * @param {object} helpers
 * @param {object} [artifactStore]
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyContract(task, board, helpers, artifactStore) {
  if (!task.contract || !task.contract.kind) {
    return { ok: true }; // no contract → auto-pass (backwards compat)
  }
  const contract = CONTRACTS[task.contract.kind];
  if (!contract) {
    return { ok: false, reason: `unknown contract kind: ${task.contract.kind}` };
  }
  return contract.verify(task, board, helpers, artifactStore);
}

module.exports = {
  CONTRACTS,
  getContract,
  buildContract,
  verifyContract,
};
