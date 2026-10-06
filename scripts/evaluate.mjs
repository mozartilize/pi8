#!/usr/bin/env node
// Command line of the evaluation harness. Node runs the TypeScript files directly.
//
//   node scripts/evaluate.mjs preflight <input.json>
//       Print the preflight matrix. The input is a PreflightInput.
//   node scripts/evaluate.mjs report <input.json>
//       Print the paired report. The input is { manifest, units, armReports }.
//
// The harness never starts a paid run from this script. A paid run needs a frozen
// manifest, an approved budget, and a program that calls runFixedArm.
import { readFileSync } from 'node:fs';
import { preflightMatrix } from '../eval/budget.ts';
import { buildReport } from '../eval/report.ts';

const [command, file] = process.argv.slice(2);
if (!file || !['preflight', 'report'].includes(command ?? '')) {
  console.error('usage: evaluate.mjs <preflight|report> <input.json>');
  process.exit(2);
}
const input = JSON.parse(readFileSync(file, 'utf8'));
console.log(JSON.stringify(command === 'preflight' ? preflightMatrix(input) : buildReport(input), null, 2));
