// Score every finished run: hidden tests, own tests, leftover names, cost, models.
// usage: node score.cjs [run-dir-filter]
// Runs live in $PI8_FLOW_DIR (default /tmp/pi8-flow); `node setup.mjs` creates it.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.env.PI8_FLOW_DIR ?? '/tmp/pi8-flow';
const filter = process.argv[2] ?? '';

function sh(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }
  catch (e) { return (e.stdout ?? '') + (e.stderr ?? ''); }
}
function nodeTest(cwd, file, env = '') {
  const out = sh(`${env} node --test ${file} 2>&1`, cwd);
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
  const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
  const failed = [...out.matchAll(/^not ok \d+ - (H\d+)/gm)].map((m) => m[1]);
  return { pass, fail, failed };
}
function session(run) {
  const dir = path.join(run, 'sessions');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('router-')) : [];
  let cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, messages = 0, errors = 0;
  const models = {};
  let lastText = '';
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'message' || e.message?.role !== 'assistant') continue;
      const m = e.message; const u = m.usage ?? {};
      messages++; if (m.stopReason === 'error') errors++;
      cost += u.cost?.total ?? 0; input += u.input ?? 0; output += u.output ?? 0; cacheRead += u.cacheRead ?? 0; cacheWrite += u.cacheWrite ?? 0;
      const key = `${m.provider}/${m.model}`; models[key] = (models[key] ?? 0) + 1;
      const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text.trim()) lastText = text;
    }
  }
  return { cost, input, output, cacheRead, cacheWrite, messages, errors, models, lastText };
}
function decisions(run) {
  const dir = path.join(run, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.router-decisions.jsonl'));
  if (!f) return [];
  return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const rows = [];
for (const name of fs.readdirSync(path.join(ROOT, 'runs')).sort()) {
  if (!name.includes(filter) || /\.r0$/.test(name)) continue;
  const run = path.join(ROOT, 'runs', name);
  if (!fs.existsSync(path.join(run, 'meta.json'))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(run, 'meta.json'), 'utf8'));
  const s = session(run);
  const row = { run: name, seconds: meta.seconds, followup: meta.followup, cost: s.cost, tokens: { in: s.input, out: s.output, cr: s.cacheRead, cw: s.cacheWrite }, messages: s.messages, errors: s.errors, models: s.models };
  const work = path.join(run, 'work');
  if (meta.case === 1 || meta.case === 3) {
    const check = path.join(run, 'check');
    fs.rmSync(check, { recursive: true, force: true });
    fs.cpSync(work, check, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'hidden/queue.hidden.test.ts'), path.join(check, 'hidden.test.ts'));
    fs.writeFileSync(path.join(check, 'hidden.test.ts'), fs.readFileSync(path.join(check, 'hidden.test.ts'), 'utf8').replace("'../src/queue.ts'", "'./src/queue.ts'"));
    row.hidden = nodeTest(check, 'hidden.test.ts', meta.case === 3 ? 'DELAY_OPTION=backoffBaseMs' : '');
    row.own = nodeTest(work, '');
  }
  if (meta.case === 3) {
    row.leftover = sh("grep -rn --exclude-dir=.git retryDelayMs . | grep -v '^./check' | wc -l", work).trim();
    const index = path.join(work, 'src/index.ts');
    const text = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
    row.index = ['createQueue', 'QueueOptions', 'AddOptions', 'JobHandle', 'Queue'].filter((n) => new RegExp(`\\b${n}\\b`).test(text)).length + '/5';
  }
  if (meta.case === 2) {
    fs.writeFileSync(path.join(run, 'review.txt'), s.lastText);
    row.reviewChars = s.lastText.length;
    row.changed = sh('diff -rq . ' + path.join(ROOT, 'case2') + ' | wc -l', work).trim();
  }
  const d = decisions(run);
  if (d.length) {
    const served = {};
    for (const x of d) { const k = `${x.dimension ?? x.decision?.dimension}:${x.chosen ?? x.decision?.chosen}`; served[k] = (served[k] ?? 0) + 1; }
    row.routes = served;
  }
  rows.push(row);
}
console.log(JSON.stringify(rows, null, 1));
