/**
 * artifact-store.js — Read/write step artifacts (input, output, log)
 *
 * Stores structured JSON artifacts per step, keyed by run_id and step_id.
 * Uses atomic writes (write .tmp then rename) for crash safety.
 *
 * Layout:
 *   server/artifacts/{run_id}/{step_id}.input.json
 *   server/artifacts/{run_id}/{step_id}.output.json
 *   server/artifacts/{run_id}/{step_id}.log
 */
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');

function artifactPath(runId, stepId, kind) {
  // step_id may contain ":" (e.g., "T-00001:plan") — replace for filesystem safety
  const safeStepId = stepId.replace(/:/g, '_');
  return path.join(ARTIFACT_DIR, runId, `${safeStepId}.${kind}.json`);
}

function writeArtifact(runId, stepId, kind, data) {
  const filePath = artifactPath(runId, stepId, kind);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

function readArtifact(runId, stepId, kind) {
  const filePath = artifactPath(runId, stepId, kind);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function artifactExists(runId, stepId, kind) {
  return fs.existsSync(artifactPath(runId, stepId, kind));
}

function listArtifacts(runId) {
  const dir = path.join(ARTIFACT_DIR, runId);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const match = f.match(/^(.+)\.(input|output)\.json$/);
        if (!match) return null;
        return { stepId: match[1].replace(/_/g, ':'), kind: match[2], path: path.join(dir, f) };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Append a JSONL entry to a step's progress log.
 * Creates the file if it doesn't exist. Useful for `tail -f` style monitoring.
 */
function appendLog(runId, stepId, entry) {
  const safeStepId = stepId.replace(/:/g, '_');
  const logPath = path.join(ARTIFACT_DIR, runId, `${safeStepId}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function logPath(runId, stepId) {
  const safeStepId = stepId.replace(/:/g, '_');
  return path.join(ARTIFACT_DIR, runId, `${safeStepId}.log`);
}

module.exports = {
  ARTIFACT_DIR,
  artifactPath,
  writeArtifact,
  readArtifact,
  artifactExists,
  listArtifacts,
  appendLog,
  logPath,
};
