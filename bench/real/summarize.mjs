// Writes the summary of a real-repository campaign again from the run manifests that it stored. Use it
// when a campaign stopped before its summary, or after a change of the leak scan.
//   node bench/real/summarize.mjs --campaign <id> [--stamp <start time of the run>]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CampaignStore } from '../../eval/budget.ts';
import { buildReport } from '../../eval/report.ts';
import { leakHits } from './leaks.mjs';
import { evalDir, root } from './lib.mjs';

const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const campaignId = arg('--campaign');
if (!campaignId) throw new Error('give --campaign');
const reports = join(evalDir, 'reports');
const runIdPattern = new RegExp(`^${campaignId}-(\\d+)-(.+)-r(\\d+)$`);
const runDirs = readdirSync(reports).map((name) => ({ name, match: runIdPattern.exec(name) })).filter(({ match }) => match);
const stamp = arg('--stamp') ?? runDirs.map(({ match }) => match[1]).sort().at(-1);
if (!stamp) throw new Error(`no run manifests for the campaign ${campaignId}`);

const validation = readdirSync(join(root, 'validation')).map((name) => JSON.parse(readFileSync(join(root, 'validation', name), 'utf8'))).filter((record) => record.valid);
const fixOf = (taskId) => validation.find((record) => `${record.repo}-${record.fix.slice(0, 10)}` === taskId)?.fix;

const armReports = [];
const results = new Map();
const leaks = {};
const taskIds = new Set();
for (const { name, match } of runDirs.filter(({ match }) => match[1] === stamp)) {
  for (const file of readdirSync(join(reports, name)).filter((entry) => entry.endsWith('.run-manifest.json'))) {
    const report = JSON.parse(readFileSync(join(reports, name, file), 'utf8'));
    armReports.push(report);
    // The run id ends with `<task>-<arm>-r<replicate>`. The arm id comes from the manifest, so a task id with a dash stays whole.
    const taskId = match[2].slice(0, -(report.armId.length + 1));
    taskIds.add(taskId);
    const list = results.get(`${taskId}/${report.armId}`) ?? [];
    for (const slot of report.slots) if (slot.kind === 'evaluated') list.push(slot.attempt);
    results.set(`${taskId}/${report.armId}`, list);
    const fix = fixOf(taskId);
    const hits = fix ? leakHits({ fix }, name) : ['unknown-task'];
    if (hits.length > 0) leaks[`${taskId}/${report.armId}/r${match[3]}`] = hits;
  }
}

const manifest = new CampaignStore(evalDir, campaignId).manifest();
const armIds = [...new Set(armReports.map((report) => report.armId))];
const current = armIds.includes('auto') ? 'auto' : armIds[1];
const candidate = armIds.find((id) => id !== current);
const units = [...taskIds].sort().map((taskId) => ({
  taskId, repositoryId: taskId.split('-')[0], current: results.get(`${taskId}/${current}`) ?? [], candidate: results.get(`${taskId}/${candidate}`) ?? [],
}));
// A task with a leak in any execution leaves the comparison in both arms, so the pairs stay matched.
const excludedTasks = [...new Set(Object.keys(leaks).map((key) => key.split('/')[0]))].sort();
const report = buildReport({ manifest, units: units.filter((unit) => !excludedTasks.includes(unit.taskId)), armReports });
const allTasksReport = buildReport({ manifest, units, armReports });
const summary = {
  purpose: 'development', rebuiltFromRunManifests: true,
  diagnosticVerdict: report.verdict, activationVerdict: null,
  reasons: report.reasons, checks: report.checks, evidence: report.evidence, metrics: report.metrics,
  ledger: new CampaignStore(evalDir, campaignId).ledger().totals(),
  arms: { candidate, current }, leaks, excludedTasks,
  allTasks: { verdict: allTasksReport.verdict, reasons: allTasksReport.reasons, checks: allTasksReport.checks, evidence: allTasksReport.evidence },
  perTask: Object.fromEntries([...results].sort().map(([key, attempts]) => [key, attempts.map((a) => ({ outcome: a.outcome, usd: a.historicalCostUsd, normalizedUsd: a.normalizedCostUsd, seconds: Math.round(a.wallTimeMs / 1000), served: a.candidateKey, fallbacks: a.fallbackCount, escalations: a.capabilityEscalations, switches: a.modelSwitches, cacheReadShare: a.cacheReadShare, servedModels: a.servedModels }))])),
};
const out = join(reports, `${campaignId}-${stamp}.summary.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ diagnosticVerdict: summary.diagnosticVerdict, reasons: summary.reasons, evidence: summary.evidence, excludedTasks }, null, 1));
console.log(`summary: ${out}`);
