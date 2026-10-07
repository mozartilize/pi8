// Finds signs that an agent of the real-repository bench looked for the fix outside its task directory.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir } from './lib.mjs';

/**
 * Signs in the tool call arguments that an agent looked for the fix outside its task directory: the
 * evaluation store, the upstream repository, a published copy of the crate, or the fix commit. The
 * namespace hides the store, but bash can still reach the network. Only the arguments count: a tool
 * result can show an upstream URL that the source code contains.
 */
const leakPatterns = (task) => [
  /pi8-eval/, /real-bench/, new RegExp(task.fix.slice(0, 7)), /\bgit\b[^"]*\b(?:fetch|clone|pull|remote add)\b/,
  /(?:github\.com|githubusercontent\.com|api\.github\.com\/repos)\/[\w.-]+\/(?:tantivy|wealthfolio|saleor)/i, /\.cargo\/registry\/src\/[^"]*\/tantivy-/,
  /crates\.io\/(?:api\/v1\/)?crates\/tantivy|static\.crates\.io\/crates\/tantivy|\bcargo (?:add|install|download)\b[^"]*\btantivy/,
];
const findSessions = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('session.jsonl')).map((name) => join(dir, String(name))) : []);
/** A tool result that shows that the blocked host refused the connection. Such a call got nothing. */
const REFUSED = /Connection refused|Errno 111|ECONNREFUSED|Failed to connect|curl: \(7\)/;
const toolCallText = (path) => {
  const calls = new Map();
  const refused = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const message = JSON.parse(line).message;
    if (!Array.isArray(message?.content)) continue;
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall') calls.set(part.id, `${part.name} ${JSON.stringify(part.arguments)}`);
    } else if (message.role === 'toolResult' && REFUSED.test(JSON.stringify(message.content))) {
      refused.add(message.toolCallId);
    }
  }
  return [...calls].filter(([id]) => !refused.has(id)).map(([, text]) => text).join('\n');
};
/** The patterns that match in the tool calls of one run. `task.fix` is the fix revision. */
export const leakHits = (task, runId) => {
  const text = findSessions(join(evalDir, 'runs', runId)).map(toolCallText).join('\n');
  return leakPatterns(task).filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
};

