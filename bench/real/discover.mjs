// Free check of candidate fix commits: which files are hidden tests, which are the fix, and the cargo arguments.
//   node bench/real/discover.mjs <repo> <sha...>      prints one JSON line for each commit
import { cargoArgsFor, git, hiddenTestsFor, REPOS } from './lib.mjs';

const [repo, ...shas] = process.argv.slice(2);
for (const sha of shas) {
  const { dir } = REPOS[repo];
  const full = git(dir, ['rev-parse', sha]).trim();
  const base = git(dir, ['rev-parse', `${full}^`]).trim();
  const subject = git(dir, ['show', '-s', '--format=%s', full]).trim();
  const line = { sha: sha.slice(0, 10), date: git(dir, ['show', '-s', '--format=%cs', full]).trim(), subject: subject.slice(0, 90) };
  try {
    const { hidden, source, other } = hiddenTestsFor(repo, base, full);
    Object.assign(line, { source, other, hidden: hidden.map((h) => `${h.kind === 'file' ? 'F' : 'M'}:${h.path}`) });
    line.args = hidden.length ? cargoArgsFor(repo, full, hidden).join(' ') : null;
  } catch (error) {
    line.error = String(error.message).slice(0, 80);
  }
  console.log(JSON.stringify(line));
}
