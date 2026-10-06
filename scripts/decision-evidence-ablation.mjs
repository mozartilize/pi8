#!/usr/bin/env node
// Ablation of the evidence that routing has at a handoff or plan.
//
//   node scripts/decision-evidence-ablation.mjs <decisions.jsonl> <labels.jsonl> [--min-tasks 20]
//
// labels.jsonl: one JSON object per line,
//   { "intentKey": "...", "outcome": "verified-pass" | "verified-fail", "task": "...", "repository": "..." }
// `task` defaults to the intent key. Rows with another outcome are not labels.
//
// The question: does a group of signals separate a verified failure from a
// verified pass? Each signal is oriented so that a higher score means a harder
// task. The script fits no weights. A group score is the mean percentile of its
// signals, and its AUC is the chance that a failed task scores above a passed
// task (a tie counts half). With fewer labelled tasks than `--min-tasks`, or
// fewer than 3 of either outcome, the numbers only describe the sample.
import { readFileSync } from 'node:fs';

const [decisionsPath, labelsPath, ...rest] = process.argv.slice(2);
if (!decisionsPath || !labelsPath) {
  console.error('usage: decision-evidence-ablation.mjs <decisions.jsonl> <labels.jsonl> [--min-tasks N]');
  process.exit(2);
}
const minTasks = Number(rest[rest.indexOf('--min-tasks') + 1]) || 20;

const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return undefined; }
}).filter(Boolean);

// direction: +1 when a higher value means a harder task.
const GROUPS = {
  A: { requirementUsed: { dir: 1, get: (r) => r.used } },
  B: {
    answersY: { dir: 1, get: (r) => Object.values(r.evidence.declaredFacts?.answers ?? {}).filter((a) => a === 'Y').length },
    decisions: { dir: 1, get: (r) => r.evidence.declaredFacts?.decisions },
    unknowns: { dir: 1, get: (r) => r.evidence.declaredFacts?.unknowns },
    external: { dir: 1, get: (r) => r.evidence.declaredFacts?.external },
    irreversible: { dir: 1, get: (r) => r.evidence.declaredFacts?.irreversible },
    precedent: { dir: -1, get: (r) => r.evidence.declaredFacts?.precedent === undefined ? undefined : Number(r.evidence.declaredFacts.precedent) },
  },
  C: {
    files: { dir: 1, get: (r) => r.evidence.files },
    directories: { dir: 1, get: (r) => r.evidence.directories },
    existingLines: { dir: 1, get: (r) => r.evidence.existingLines },
    fixCommits: { dir: 1, get: (r) => r.evidence.fixCommits },
    filenameFanIn: { dir: 1, get: (r) => r.evidence.filenameFanIn },
    coveringTestNames: { dir: -1, get: (r) => r.evidence.coveringTestNames },
  },
  D: {
    scoutFiles: { dir: 1, get: (r) => r.evidence.scoutFiles },
    scoutRequests: { dir: 1, get: (r) => r.evidence.scoutRequests },
    partialReadCount: { dir: 1, get: (r) => r.evidence.partialReadCount },
    trajectorySignals: { dir: 1, get: (r) => r.evidence.trajectorySignals?.length ?? 0 },
  },
  E: {
    checkStrength: { dir: -1, get: (r) => ({ none: 0, partial: 1, contract: 2 })[r.evidence.checkStrength] },
    lastCheckFailed: { dir: 1, get: (r) => r.evidence.lastCheckVerdict === undefined ? undefined : Number(r.evidence.lastCheckVerdict !== 'pass') },
  },
};
const ABLATIONS = [['A'], ['A', 'B'], ['A', 'C'], ['A', 'D'], ['A', 'E'], ['A', 'B', 'C', 'D', 'E']];

// The latest accepted boundary of each intent: one row per task, never two.
const boundary = new Map();
for (const entry of lines(decisionsPath)) {
  const handoff = entry.kind === 'investigation-handoff' && entry.investigationHandoff?.action === 'accept' ? entry.investigationHandoff : undefined;
  const contract = entry.kind === 'execution-contract' && entry.executionContract?.action === 'accept' ? entry.executionContract : undefined;
  const evidence = handoff?.evidence ?? contract?.evidence;
  if (!evidence || !entry.intentKey) continue;
  boundary.set(entry.intentKey, { evidence, used: (handoff?.facts ?? contract?.meta?.facts)?.shadow?.used });
}

const rows = [];
for (const label of lines(labelsPath)) {
  const decision = boundary.get(label.intentKey);
  if (!decision || !['verified-pass', 'verified-fail'].includes(label.outcome)) continue;
  rows.push({ ...decision, fail: label.outcome === 'verified-fail', task: label.task ?? label.intentKey, repository: label.repository });
}

const percentile = (rowsWith, get) => {
  const sorted = rowsWith.map(get).sort((a, b) => a - b);
  const rank = (v) => (sorted.filter((x) => x < v).length + (sorted.filter((x) => x === v).length + 1) / 2) / (sorted.length + 1);
  return rank;
};

function score(groups) {
  const signals = groups.flatMap((g) => Object.values(GROUPS[g]));
  const ranks = signals.map((s) => {
    const defined = rows.filter((r) => typeof s.get(r) === 'number');
    return { s, rank: percentile(defined, s.get) };
  });
  return rows.map((r) => {
    const parts = ranks.filter(({ s }) => typeof s.get(r) === 'number')
      .map(({ s, rank }) => s.dir === 1 ? rank(s.get(r)) : 1 - rank(s.get(r)));
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : undefined;
  });
}

function auc(scores) {
  const failed = scores.filter((v, i) => v !== undefined && rows[i].fail);
  const passed = scores.filter((v, i) => v !== undefined && !rows[i].fail);
  if (!failed.length || !passed.length) return { auc: undefined, failed: failed.length, passed: passed.length };
  let wins = 0;
  for (const f of failed) for (const p of passed) wins += f > p ? 1 : f === p ? 0.5 : 0;
  return { auc: wins / (failed.length * passed.length), failed: failed.length, passed: passed.length };
}

const tasks = new Set(rows.map((r) => r.task));
const failedTasks = new Set(rows.filter((r) => r.fail).map((r) => r.task)).size;
const sufficient = tasks.size >= minTasks && failedTasks >= 3 && tasks.size - failedTasks >= 3;
console.log(`labelled rows ${rows.length}, tasks ${tasks.size}, repositories ${new Set(rows.map((r) => r.repository).filter(Boolean)).size}`);
console.log(sufficient ? 'evidence: enough labels to read the table' : `evidence: INSUFFICIENT (needs ${minTasks} tasks and 3 of each outcome); numbers describe this sample only`);
const base = auc(score(['A'])).auc;
for (const groups of ABLATIONS) {
  const result = auc(score(groups));
  const delta = result.auc === undefined || base === undefined ? '' : `  delta vs A ${(result.auc - base).toFixed(3)}`;
  console.log(`${groups.join('+').padEnd(11)} auc ${result.auc === undefined ? 'n/a' : result.auc.toFixed(3)}  failed ${result.failed} passed ${result.passed}${delta}`);
}
