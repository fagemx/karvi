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
 *
 * Encryption:
 *   When encryption is enabled, artifact content is encrypted at rest
 *   using AES-256-GCM. The encryption module must be initialized first.
 */
const fs = require('fs');
const path = require('path');
const enc = require('./encryption');

const ARTIFACT_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), 'artifacts')
  : path.join(__dirname, 'artifacts');

function artifactPath(runId, stepId, kind) {
  // step_id may contain ":" (e.g., "T-00001:plan") — replace for filesystem safety
  const safeStepId = stepId.replace(/:/g, '_');
  return path.join(ARTIFACT_DIR, runId, `${safeStepId}.${kind}.json`);
}

function encryptContent(content, context) {
  if (!enc.isEnabled()) return content;
  if (typeof content === 'string') {
    return enc.encryptField(content, context);
  }
  if (typeof content === 'object' && content !== null) {
    return enc.encryptField(JSON.stringify(content), context);
  }
  return content;
}

function decryptContent(entry, context) {
  if (!enc.isEnabled()) return entry;
  if (entry && entry._encrypted) {
    const decrypted = enc.decryptField(entry, context);
    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted;
    }
  }
  return entry;
}

function writeArtifact(runId, stepId, kind, data) {
  const filePath = artifactPath(runId, stepId, kind);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  
  let dataToWrite = data;
  if (enc.isEnabled() && data) {
    const context = `artifact:${runId}:${stepId}:${kind}`;
    dataToWrite = {
      ...data,
      _encrypted: true,
    };
    if (data.content) {
      dataToWrite.content = encryptContent(data.content, `${context}:content`);
    }
    if (data.prompt) {
      dataToWrite.prompt = encryptContent(data.prompt, `${context}:prompt`);
    }
    if (data.response) {
      dataToWrite.response = encryptContent(data.response, `${context}:response`);
    }
  }
  
  fs.writeFileSync(tmpPath, JSON.stringify(dataToWrite, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

function readArtifact(runId, stepId, kind) {
  const filePath = artifactPath(runId, stepId, kind);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (data._encrypted && enc.isEnabled()) {
      const context = `artifact:${runId}:${stepId}:${kind}`;
      const decrypted = { ...data };
      delete decrypted._encrypted;
      
      if (data.content && data.content._encrypted) {
        decrypted.content = decryptContent(data.content, `${context}:content`);
      }
      if (data.prompt && data.prompt._encrypted) {
        decrypted.prompt = decryptContent(data.prompt, `${context}:prompt`);
      }
      if (data.response && data.response._encrypted) {
        decrypted.response = decryptContent(data.response, `${context}:response`);
      }
      
      return decrypted;
    }
    
    return data;
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

/**
 * List all run directories in the artifact store.
 * Returns array of run_id strings.
 */
function listAllRuns() {
  try {
    return fs.readdirSync(ARTIFACT_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

function readLogLines(runId, stepId) {
  const filePath = logPath(runId, stepId);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed));
      } catch { }
    }
    return lines;
  } catch {
    return [];
  }
}

const MAX_READ_CHUNK = 1024 * 1024; // 1MB 上限，防止大 log burst 造成記憶體尖峰

function watchLog(runId, stepId, callback) {
  const filePath = logPath(runId, stepId);
  let lastSize = 0;
  try {
    const stat = fs.statSync(filePath);
    lastSize = stat.size;
  } catch { }

  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > lastSize) {
        const chunkSize = Math.min(stat.size - lastSize, MAX_READ_CHUNK);
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(chunkSize);
        fs.readSync(fd, buffer, 0, buffer.length, lastSize);
        fs.closeSync(fd);
        const newContent = buffer.toString('utf8');
        lastSize = lastSize + chunkSize;
        for (const line of newContent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            callback(JSON.parse(trimmed));
          } catch { /* malformed JSONL line — skip */ }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[artifact-store] watchLog error for ${runId}/${stepId}:`, err.message);
        clearInterval(interval);
      }
    }
  }, 500);

  return () => clearInterval(interval);
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
  listAllRuns,
  readLogLines,
  watchLog,
};
