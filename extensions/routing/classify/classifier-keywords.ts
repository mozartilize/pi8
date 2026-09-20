/**
 * Default keyword lists ported from LiteLLM's complexity router (Apache-2.0).
 * These seed the classifier's dimension scoring; user-configurable via config.
 */
import type { Dimension } from '../../types.js';

export const CODE_KEYWORDS: string[] = [
  'function', 'class', 'def', 'const', 'let', 'var',
  'import', 'export', 'return', 'async', 'await',
  'try', 'catch', 'exception', 'error', 'debug',
  'api', 'endpoint', 'request', 'response',
  'database', 'sql', 'query', 'schema',
  'algorithm', 'implement', 'refactor', 'optimize',
  'python', 'javascript', 'typescript', 'java', 'rust', 'golang',
  'react', 'vue', 'angular', 'node',
  'docker', 'kubernetes', 'git', 'commit', 'merge', 'branch',
  'pull request', 'diff', 'patch', 'lint', 'build', 'deploy',
  'framework', 'library', 'package', 'dependency',
  'syntax error', 'type error', 'undefined', 'null', 'promise',
  'frontend', 'backend', 'full stack', 'devops',
  'unit test', 'integration test', 'e2e test',
  'typescript', 'browser',
];

export const REASONING_KEYWORDS: string[] = [
  'step by step', 'think through', "let's think", 'reason through',
  'analyze this', 'break down', 'explain your reasoning',
  'show your work', 'chain of thought', 'think carefully',
  'consider all', 'consider whether', 'evaluate', 'pros and cons',
  'compare and contrast', 'weigh the options', 'weigh up',
  'logical', 'deduce', 'infer', 'conclude',
  'design', 'architect', 'trade-off', 'should we',
  'decide', 'which is better', 'prove', 'derive',
  'what if', 'think about',
];

export const TECHNICAL_KEYWORDS: string[] = [
  'architecture', 'distributed', 'scalable', 'microservice',
  'machine learning', 'neural network', 'deep learning',
  'encryption', 'authentication', 'authorization',
  'performance', 'latency', 'throughput', 'benchmark',
  'concurrency', 'parallel', 'threading',
  'memory', 'cpu', 'gpu', 'optimization',
  'protocol', 'tcp', 'http', 'grpc', 'websocket', 'graphql', 'rest',
  'container', 'orchestration', 'async',
  'mutex', 'semaphore', 'lock', 'race condition',
  'big o', 'complexity', 'computational', 'algorithmic',
  'sharding', 'replication', 'idempotent', 'eventual consistency',
  'queue', 'pub/sub', 'streaming', 'observability',
];

export const SIMPLE_KEYWORDS: string[] = [
  'what is', "what's", 'define', 'definition of',
  'who is', 'who was', 'who are', 'when did', 'when was',
  'how many', 'how much',
  'yes or no', 'true or false',
  'simple', 'brief', 'short', 'quick',
  'hello', 'hi', 'hey', 'thanks', 'thank you',
  'goodbye', 'bye', 'okay', 'ok',
  'rename', 'fix typo', 'typo', 'add comment',
  'how do i', 'tell me',
];

/**
 * Read-only exploration: locating, listing and summarizing existing code.
 *
 * These navigation verbs are split out from SIMPLE_KEYWORDS so exploration
 * requests (e.g. "show me", "where is") don't score as small talk.
 */
export const GATHER_KEYWORDS: string[] = [
  'find', 'search', 'locate', 'look up', 'look for', 'look through',
  'grep', 'list', 'enumerate', 'show me', 'which file', 'which files',
  'where is', 'where are', 'where does', 'where do',
  'summarize', 'summarise', 'summary of', 'overview of',
  'what does', 'what do', 'read the', 'inspect', 'trace', 'walk me through',
  'explore', 'find out', 'figure out where', 'callers of', 'usages of',
  'research', 'investigate', 'look into', 'dig into', 'check out',
  'go through', 'report', 'status', 'progress', 'tell me about',
  'how does', 'what happened', 'examine', 'analyze', 'read about',
];

/**
 * Critique of existing work. The `review` dimension existed in the type and in
 * the scorer, but no classifier code path ever returned it.
 */
export const REVIEW_KEYWORDS: string[] = [
  'review', 'code review', 'audit', 'critique', 'criticize',
  'feedback on', 'look over', 'go over', 'sanity check', 'double check',
  'is this correct', 'is this right', 'am i missing', 'what am i missing',
  'security issue', 'vulnerabilit', 'edge case', 'edge cases',
  'anti-pattern', 'antipattern', 'code smell', 'smells',
  'correctness', 'regression', 'nitpick', 'lgtm',
];

/**
 * Forward-looking design work, as opposed to REASONING_KEYWORDS which capture
 * the *style* of thinking requested.
 */
export const PLAN_KEYWORDS: string[] = [
  'plan', 'roadmap', 'strategy', 'proposal', 'rfc', 'spec out',
  'migration', 'rewrite', 'redesign', 'restructure',
  'architecture', 'architect', 'high level', 'high-level',
  'approach', 'options', 'alternatives', 'trade-off', 'tradeoff',
  'should we', 'how should', 'best way to', 'brainstorm',
  'what if', 'expose', 'api design', 'public api', 'how would',
  'should i', 'think about', 'thoughts on',
];

/**
 * Leading imperative verbs. Agent prompts are overwhelmingly imperative, so the
 * first few words are a far stronger intent signal than bag-of-words counts.
 */
export const INTENT_VERBS: Record<string, Dimension> = {
  plan: 'plan',
  design: 'plan',
  architect: 'plan',
  draft: 'plan',
  propose: 'plan',
  evaluate: 'plan',
  compare: 'plan',
  decide: 'plan',
  sketch: 'plan',

  review: 'review',
  audit: 'review',
  critique: 'review',
  check: 'review',
  verify: 'review',
  validate: 'review',

  find: 'gather',
  search: 'gather',
  locate: 'gather',
  list: 'gather',
  show: 'gather',
  summarize: 'gather',
  summarise: 'gather',
  explain: 'gather',
  describe: 'gather',
  read: 'gather',
  grep: 'gather',
  where: 'gather',
  research: 'plan',
  investigate: 'gather',
  explore: 'gather',
  report: 'gather',
  analyze: 'gather',
  examine: 'gather',

  implement: 'implement',
  add: 'implement',
  write: 'implement',
  create: 'implement',
  build: 'implement',
  fix: 'implement',
  refactor: 'implement',
  update: 'implement',
  remove: 'implement',
  delete: 'implement',
  migrate: 'implement',
  port: 'implement',
  optimize: 'implement',
  extract: 'implement',
  wire: 'implement',
  // Leading imperatives that describe code-mutating work. As a LEADING verb
  // (first meaningful token) these are unambiguous implement intents even
  // when a bag-of-words keyword (e.g. 'rewrite' in PLAN_KEYWORDS) would
  // otherwise pull toward plan/gather.
  debug: 'implement',
  diagnose: 'implement',
  troubleshoot: 'implement',
  convert: 'implement',
  rewrite: 'implement',
  document: 'implement',
  test: 'implement',
  configure: 'implement',
  setup: 'implement',
  set: 'implement',
  scaffold: 'implement',
  generate: 'implement',
  install: 'implement',
};

export const DIMENSION_STRENGTH: Record<Dimension, number> = {
  lightweight: 0,
  gather: 1,
  implement: 2,
  review: 3,
  plan: 4,
};
