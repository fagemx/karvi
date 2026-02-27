#!/usr/bin/env node
/**
 * process-brief.js — Atomic brief processor
 * 
 * Reads brief.json, finds all dispatched shots, generates images,
 * writes everything back in one atomic operation.
 * 
 * Usage:
 *   node process-brief.js                          # process all dispatched
 *   node process-brief.js --shot S3                # process only S3
 *   node process-brief.js --brief /path/brief.json # custom brief path
 *   node process-brief.js --dry-run                # preview without generating
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const API_JS = path.join(SCRIPT_DIR, '..', '..', 'scripts', 'api.js');
const DEFAULT_BRIEF = path.join(SCRIPT_DIR, 'brief.json');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--brief') args.brief = argv[++i];
    else if (argv[i] === '--shot') args.shot = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--model') args.model = argv[++i];
  }
  return args;
}

function backupBrief(briefPath) {
  const bak = briefPath + '.bak';
  fs.copyFileSync(briefPath, bak);
  return bak;
}

function buildPrompt(shot, project) {
  const style = project.style || '';
  const constraints = (project.constraints || []).join('、');
  const must = (shot.must || []).join('、');
  const neg = (shot.neg || []).join('、');

  let prompt = shot.goal;

  if (style) prompt += `。風格：${style}`;
  if (must) prompt += `。必須包含：${must}`;
  if (neg) prompt += `。禁止：${neg}`;
  if (constraints) prompt += `。限制：${constraints}`;

  if (shot.action === 'fix' && (shot.action_detail || shot.user_feedback)) {
    const feedback = shot.action_detail || shot.user_feedback;
    prompt += `。根據修改要求調整：${feedback}`;
  }

  return prompt;
}

function generateImage(prompt, shotId, version, model) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const filename = `${shotId}_v${version}.jpg`;
  const outPath = path.join(OUTPUT_DIR, filename);

  let cmd = `node "${API_JS}" image --prompt "${prompt.replace(/"/g, '\\"')}" --aspect 16:9 --outdir "${OUTPUT_DIR}" --name "${filename}"`;
  if (model) cmd += ` --model ${model}`;

  console.log(`  [gen] ${shotId} v${version}...`);

  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const result = JSON.parse(stdout.trim());
    return {
      url: result.imageUrl || result.fullWebpUrl || null,
      local_path: fs.existsSync(outPath) ? `output/${filename}` : (result.localPath || null),
      success: true
    };
  } catch (e) {
    console.error(`  [error] ${shotId}: ${e.message}`);
    return { url: null, local_path: null, success: false, error: e.message };
  }
}

function processShot(shot, project, model, dryRun) {
  const prompt = buildPrompt(shot, project);
  const version = (shot.history ? shot.history.length : 0) + 1;

  console.log(`\n[${shot.id}] action=${shot.action}, version=${version}`);
  console.log(`  prompt: ${prompt.substring(0, 100)}...`);

  if (dryRun) {
    console.log('  [dry-run] skipping generation');
    return false;
  }

  if (!shot.history) shot.history = [];

  if (shot.generated_url) {
    shot.history.push({
      version: version - 1 > 0 ? version - 1 : 1,
      url: shot.generated_url,
      local_path: shot.local_path || null,
      score: shot.score,
      time: shot.dispatched_at || new Date().toISOString(),
      feedback: shot.action_detail || shot.user_feedback || null
    });
  }

  const result = generateImage(prompt, shot.id, version, model);

  if (result.success) {
    shot.status = 'review';
    shot.generated_url = result.url;
    shot.local_path = result.local_path;
    shot.score = null;
    shot.action = null;
    shot.action_detail = null;
    console.log(`  [ok] url=${result.url ? result.url.substring(0, 60) + '...' : 'none'}`);
    console.log(`  [ok] local=${result.local_path || 'none'}`);
    return true;
  } else {
    shot.status = 'review';
    shot.action = null;
    shot.action_detail = null;
    console.log(`  [fail] ${result.error}`);
    return false;
  }
}

function main() {
  const args = parseArgs();
  const briefPath = args.brief || DEFAULT_BRIEF;

  if (!fs.existsSync(briefPath)) {
    console.error(`brief not found: ${briefPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(API_JS)) {
    console.error(`api.js not found: ${API_JS}`);
    process.exit(1);
  }

  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  const shots = brief.shotspec.shots;

  const dispatched = shots.filter(s => {
    if (s.status !== 'dispatched') return false;
    if (args.shot && s.id !== args.shot) return false;
    return true;
  });

  if (dispatched.length === 0) {
    console.log('No dispatched shots found.');
    process.exit(0);
  }

  console.log(`Found ${dispatched.length} dispatched shot(s): ${dispatched.map(s => s.id).join(', ')}`);

  if (!args.dryRun) {
    const bak = backupBrief(briefPath);
    console.log(`Backup: ${bak}`);
  }

  const now = new Date().toISOString();
  let processed = 0;

  for (const shot of dispatched) {
    const ok = processShot(shot, brief.project, args.model, args.dryRun);
    if (ok) {
      processed++;
      brief.log.push({
        time: now,
        agent: 'process-brief',
        action: shot.action === 'fix' ? 'shot_fixed' : 'shot_generated',
        detail: `${shot.id} 處理完成 (v${shot.history.length})`
      });
    }
  }

  if (!args.dryRun && processed > 0) {
    fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2), 'utf8');
    console.log(`\nBrief updated: ${processed}/${dispatched.length} shots processed.`);
  } else if (args.dryRun) {
    console.log(`\n[dry-run] Would process ${dispatched.length} shots.`);
  } else {
    console.log('\nNo shots successfully processed.');
  }
}

main();
