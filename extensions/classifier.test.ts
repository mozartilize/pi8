import { describe, it, expect } from 'vitest';
import { classify, estimateTokenCount } from './classifier.js';
import { CONFIDENCE_FLOOR } from './constants.js';

describe('classifier', () => {
  // ─── Dimension classification ─────────────────────────────

  it('classifies a code diff as implement', () => {
    const prompt = `Here's a diff to fix the login bug:
\`\`\`diff
-function authenticate(user: User): boolean {
-  return checkPassword(user);
+async function authenticate(user: User): Promise<boolean> {
+  const ok = await checkPasswordAsync(user);
+  return ok;
+}
\`\`\``;
    const result = classify(prompt);
    expect(result.dimension).toBe('implement');
    expect(result.signals.some(s => s.includes('code'))).toBe(true);
  });

  it('classifies architecture design as plan', () => {
    const prompt =
      'Design a distributed caching architecture for our microservice platform. Consider trade-offs between Redis cluster and memcached. Step by step, evaluate pros and cons.';
    const result = classify(prompt);
    expect(result.dimension).toBe('plan');
  });

  it('classifies summarizing a file as gather', () => {
    const prompt = 'Summarize the main function in src/server.ts and explain what each middleware does.';
    const result = classify(prompt);
    expect(['gather', 'implement']).toContain(result.dimension);
  });

  it('classifies a review request as lightweight', () => {
    const prompt = 'Is this code correct? Just a quick check.';
    const result = classify(prompt);
    expect(result.dimension).toBe('lightweight');
  });

  it('classifies a brief greeting as lightweight', () => {
    const prompt = 'hi there';
    const result = classify(prompt);
    expect(result.dimension).toBe('lightweight');
  });

  it('classifies a rename request as lightweight', () => {
    const prompt = 'rename getFoo to getBar in utils.ts';
    const result = classify(prompt);
    expect(result.dimension).toBe('lightweight');
  });

  it('classifies a reasoning-heavy prompt as plan', () => {
    const prompt =
      "Let's think through whether we should use a monorepo or polyrepo. Compare and contrast the approaches, consider all trade-offs, evaluate the CI/CD implications, and decide which is better for a team of 15 engineers.";
    const result = classify(prompt);
    expect(result.dimension).toBe('plan');
  });

  it('keeps the default LiteLLM complexity policy behavior', () => {
    // Characterization of the shared numeric policy: a prompt with code,
    // reasoning, and technical terms must keep its stable dimension and
    // weighted score so the centralized constants cannot drift the policy.
    const result = classify('review this TypeScript race condition and explain the algorithm tradeoffs');
    expect(result.dimension).toBe('review');
  });

  // ─── Confidence ────────────────────────────────────────────

  it('assigns high confidence to clear dimensions', () => {
    const prompt = 'Implement a new REST endpoint for user registration with database schema';
    const result = classify(prompt);
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('uses the caller threshold for low-confidence route-up', () => {
    const prompt = 'research and analyze';
    const normal = classify(prompt, undefined, { lowConfidenceThreshold: 0 });
    const cautious = classify(prompt, undefined, { lowConfidenceThreshold: 1 });
    expect(normal.dimension).toBe('gather');
    expect(cautious.dimension).toBe('plan');
    expect(cautious.confidence).toBe(normal.confidence);
  });

  it('uses the reported confidence for thresholds below the confidence floor', () => {
    const result = classify('thanks design', undefined, { lowConfidenceThreshold: 0.099 });
    // Reported confidence is clamped to the floor, never below it, so a
    // caller threshold under the floor cannot flip the routed dimension.
    expect(result.confidence).toBe(CONFIDENCE_FLOOR);
    expect(result.dimension).toBe('lightweight');
  });

  it('does not treat incidental thanks in a long uncategorized prompt as categorical evidence', () => {
    const result = classify(`thanks ${'background '.repeat(80)}`);
    expect(result.hasCategoricalEvidence).toBe(false);
  });

  it('routes up on ambiguous prompts', () => {
    const prompt = 'Fix the bug';
    const result = classify(prompt);
    expect(result.dimension).toBeDefined();
    // should not crash or return NaN
    expect(result.confidence).toBeGreaterThan(0);
  });

  // ─── Signal detection ──────────────────────────────────────

  it('detects code keywords even with surrounding prose', () => {
    const prompt =
      "We need to refactor the database layer. The sql query in the endpoint needs to be async, and we should catch the exception. Also optimize the python script.";
    const result = classify(prompt);
    expect(result.signals.some(s => s.includes('code'))).toBe(true);
  });

  it('does not flag empty prompt as anything strong', () => {
    const result = classify('');
    expect(result.dimension).toBe('lightweight');
    expect(result.confidence).toBeGreaterThanOrEqual(0.1);
  });

  // ─── Regression / M4b corpus ─────────────────────────────

  it('classifies a conversational research prompt as plan (not lightweight)', () => {
    const prompt =
      'ok, put it aside, lets try something harder. currently we learn pi-subagents and support it, what if after we publish this extension, other extensions especially subagents extensions want to utilize it, which mean we have to expose some apis for them to use, go for a research';
    const result = classify(prompt);
    expect(result.dimension).toBe('plan');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('classifies api-design research as plan', () => {
    const prompt = 'what if we expose a public api for subagent extensions to consume';
    const result = classify(prompt);
    expect(result.dimension).toBe('plan');
  });

  it('classifies investigation prompts as gather or higher', () => {
    const prompt = 'investigate whether pi-subagents consumers need a public api';
    const result = classify(prompt);
    expect(['gather', 'plan']).toContain(result.dimension);
  });

  it('classifies report requests as gather (cheap research)', () => {
    const prompt = 'report the progress from @docs/superpowers/specs/';
    const result = classify(prompt);
    expect(result.dimension).toBe('gather');
  });

  it('does not let a leading "ok" push a long deliberative prompt to lightweight', () => {
    const prompt =
      'ok, so what i need is to think about whether we should split the router into its own package and expose a stable api surface. research the options and trade-offs.';
    const result = classify(prompt);
    expect(result.dimension).not.toBe('lightweight');
    expect(['gather', 'plan']).toContain(result.dimension);
  });

  // ─── Non-English safety (layer 1 universal fallback) ──────

  it('does not misclassify a Chinese plan prompt as lightweight', () => {
    const result = classify('请帮我设计一个分布式缓存系统的架构，比较两种方案的优缺点');
    expect(result.dimension).not.toBe('lightweight');
  });

  it('does not misclassify a Russian plan prompt as lightweight', () => {
    const result = classify(
      'спроектируй архитектуру распределённой системы кэширования и сравни варианты реализации',
    );
    expect(result.dimension).not.toBe('lightweight');
    // No English keywords → universal safe default.
    expect(result.dimension).toBe('gather');
  });

  it('does not misclassify an Arabic implementation prompt as lightweight', () => {
    const result = classify(
      'أريدك أن تكتب لي دالة جديدة لمعالجة طلبات المستخدمين مع اختبارات الوحدة المناسبة لها',
    );
    expect(result.dimension).not.toBe('lightweight');
  });

  it('does not misclassify a Japanese review prompt as lightweight', () => {
    const result = classify('このコードをレビューして、セキュリティの問題がないか確認してください');
    expect(result.dimension).not.toBe('lightweight');
  });

  it('still treats a short non-English greeting as lightweight', () => {
    expect(classify('hola').dimension).toBe('lightweight');
    expect(classify('привет').dimension).toBe('lightweight');
    expect(classify('你好').dimension).toBe('lightweight');
  });

  // ─── Short substantive non-English (was broken — #1-3) ────

  it('does not misclassify a short substantive CJK prompt as lightweight', () => {
    // 11 chars, 11 tokens — under the 15-token bar but NOT small talk.
    expect(classify('分析代码并修复安全漏洞').dimension).not.toBe('lightweight');
    expect(classify('修复这个登录错误并添加测试').dimension).not.toBe('lightweight');
    expect(classify('帮我优化这个数据库查询').dimension).not.toBe('lightweight');
    expect(classify('この関数をリファクタリングして').dimension).not.toBe('lightweight');
  });

  it('routes short non-English prompts to the universal safe default (gather)', () => {
    // No English keywords matched → evidence is empty → falls to gather.
    expect(classify('分析代码并修复安全漏洞').dimension).toBe('gather');
    expect(classify('重构认证中间件').dimension).toBe('gather');
  });

  it('reports no categorical evidence for pure non-English prompts', () => {
    // Length-only heuristics should not count as categorical evidence.
    expect(classify('分析代码并修复安全漏洞').hasCategoricalEvidence).toBe(false);
    expect(classify('この関数をリファクタリングして').hasCategoricalEvidence).toBe(false);
    // Genuine small talk (short greeting) also has no categorical evidence.
    expect(classify('你好').hasCategoricalEvidence).toBe(false);
  });

  // ─── System-prompt isolation ───────────────────────────────

  it('does not let an English system prompt dominate a non-English user prompt', () => {
    const sys = 'You are a coding assistant. Use functions to edit files. Work with APIs and databases. Use git to commit code.';
    // A bare Chinese greeting should still be lightweight, not implement
    // just because the system prompt mentions code/APIs/databases/git.
    const r = classify('你好', sys);
    expect(r.dimension).not.toBe('implement');
    expect(r.dimension).toBe('lightweight');
  });

  it('classifies a coding request in English with a system prompt normally', () => {
    const sys = 'You are a coding assistant. Use functions to edit files.';
    // English implement prompt + system prompt should still work.
    const r = classify('refactor the auth middleware to use async handlers', sys);
    expect(r.dimension).toBe('implement');
  });

  // ─── Token counting ───────────────────────────────────────

  it('counts non-ASCII text at roughly one token per character', () => {
    // 20 Cyrillic chars → ~20 tokens, not ceil(20/4)=5.
    expect(estimateTokenCount('спроектируй систему')).toBeGreaterThanOrEqual(17);
    // Pure ASCII keeps the 4-chars/token heuristic.
    expect(estimateTokenCount('hello world')).toBe(3);
    // Mixed text: ASCII at /4 plus each non-ASCII char.
    expect(estimateTokenCount('héllo')).toBe(2); // 4 ascii → 1, + 1 é
  });
});
