/**
 * Consistency guard for the shared route-up invocation contract.
 *
 * The same invocation contract is rendered in two forms:
 *  - ROUTE_UP_INLINE_GUIDANCE in escalation.ts: a compressed single-paragraph
 *    injected into every eligible model's system prompt (token-cost sensitive).
 *  - skills/route-up/SKILL.md: the full discoverable skill. Its "Router
 *    behavior and boundaries" section is SKILL-ONLY BY DESIGN (subagent
 *    contract, repick semantics) and is intentionally absent from the inline.
 *
 * This test guards the SHARED invocation contract against drift under manual
 * edits. It asserts the key tokens/claims both renderings must agree on —
 * dimensions, pre-answer timing, and do-not-escalate exclusions — without
 * pinning exact phrasing (contract, not snapshot).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ROUTE_UP_INLINE_GUIDANCE } from './escalation.js';

const skillPath = new URL('../skills/route-up/SKILL.md', import.meta.url);
const skillBody = readFileSync(skillPath, 'utf8').toLowerCase();
const inlineBody = ROUTE_UP_INLINE_GUIDANCE.toLowerCase();

describe('route-up invocation contract — inline ↔ SKILL.md consistency', () => {
  it('lists the same four dimensions', () => {
    for (const dim of ['plan', 'review', 'implement', 'gather']) {
      expect(inlineBody).toContain(dim);
      expect(skillBody).toContain(dim);
    }
  });

  it('requires calling route_up BEFORE a substantive answer', () => {
    // Both renderings mandate pre-answer escalation, not after text is
    // produced. Check for the tokens "before" and "route_up" in each.
    // The inline uses "BEFORE writing a substantive answer"; SKILL.md uses
    // "BEFORE writing a substantive answer" identically.
    expect(inlineBody).toContain('before');
    expect(inlineBody).toContain('route_up');
    expect(skillBody).toContain('before');
    expect(skillBody).toContain('route_up');
  });

  it('shares the same do-not-escalate exclusions', () => {
    // Both list tasks the model CAN genuinely handle and should NOT escalate:
    // summaries, renames, factual lookups, formatting.
    const exclusions = ['summaries', 'renames', 'factual lookups', 'formatting'];
    for (const token of exclusions) {
      expect(inlineBody).toContain(token);
      expect(skillBody).toContain(token);
    }
  });

  it('skill.md has the additional boundaries section (not inline)', () => {
    // The "Router behavior and boundaries" section lives only in SKILL.md and
    // must NOT be injected inline (it covers subagent contracts and repick
    // semantics irrelevant to a serving model that needs to escalate).
    expect(skillBody).toContain('router behavior and boundaries');
    expect(inlineBody).not.toContain('router behavior and boundaries');
  });
});
