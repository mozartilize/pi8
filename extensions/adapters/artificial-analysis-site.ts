/**
 * Artificial Analysis models page, read in headless Chromium.
 *
 * The free API publishes only the intelligence, coding, and agentic indexes.
 * The models page carries more per model (Omniscience, AA-Briefcase, time per
 * task, Terminal-Bench 4.0, the estimated-index flag), but only inside an encrypted
 * `/data/<hash>.txt` blob that the page decrypts in client JS. Wrapping
 * `JSON.parse` before the page loads captures the decrypted
 * `{ models: [...] }` payload; no HTML is parsed.
 *
 * Chromium for Playwright is a user setup step for `/router-sync`, not a
 * router error: without it the sync fails with `playwrightSetupText()` and
 * keeps the previous store. Serving reads only the persisted store.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const AA_SITE_PAGE = 'https://artificialanalysis.ai/models';
/** Navigation and payload capture each get this long before the sync fails. */
export const AA_SITE_TIMEOUT_MS = 60_000;
/** A real payload lists hundreds of models; fewer means a different JSON was captured. */
const MIN_SITE_ROWS = 100;

/** The fields the router reads from one models-page row. */
export interface AASiteModel {
  slug: string;
  name: string;
  intelligenceIndexIsEstimated?: boolean;
  omniscience?: number;
  lcr?: number;
  mmmuPro?: number;
  briefcaseRubricPassRate?: number;
  intelligenceIndexTimePerTask?: number;
  /** Terminal-Bench 4.0 pass rate in [0, 1]: agentic coding tasks in a real terminal. */
  terminalBench40?: number;
  /** `intelligenceIndexOutputTokensPerTask.output`: weighted answer and reasoning tokens per task. */
  outputTokensPerTask?: number;
  /** The page has a token object, but its `output` is not a finite nonnegative number. */
  outputTokensInvalid?: true;
}

/**
 * The Intelligence Index version that the models page shows, from labels such
 * as `Intelligence Index v4.3.2`. The captured payload has no version field.
 * No label, or two different labels, gives undefined: the version is unknown.
 */
export function parseSiteIndexVersion(labels: readonly string[]): string | undefined {
  const versions = new Set<string>();
  for (const label of labels) {
    for (const match of label.matchAll(/Intelligence Index v(\d+(?:\.\d+)*)/g)) versions.add(match[1]!);
  }
  return versions.size === 1 ? [...versions][0] : undefined;
}

/** Read only `.output`. Do not round, and do not convert strings. */
function outputTokens(value: unknown): Pick<AASiteModel, 'outputTokensPerTask' | 'outputTokensInvalid'> {
  if (value == null) return {};
  const output = typeof value === 'object' ? (value as { output?: unknown }).output : undefined;
  return typeof output === 'number' && Number.isFinite(output) && output >= 0
    ? { outputTokensPerTask: output }
    : { outputTokensInvalid: true };
}

/** The exact install command for the `playwright-core` this package resolves. */
export function playwrightSetupText(): string {
  let cli = 'npx playwright-core';
  try {
    const packageJson = createRequire(import.meta.url).resolve('playwright-core/package.json');
    cli = `node "${join(dirname(packageJson), 'cli.js')}"`;
  } catch {
    // The generic command still names the right tool.
  }
  return [
    'router/auto reads Artificial Analysis benchmark data with Chromium for Playwright, which is not installed. Run:',
    `  ${cli} install --no-shell chromium`,
    'Then run /router-sync. If Chromium then cannot start on Linux, run the same command with --with-deps (needs sudo).',
  ].join('\n');
}

export type PlaywrightCheck = { ready: true } | { ready: false; message: string };

let chromiumFound = false;

/**
 * Whether Chromium for Playwright is installed. A found browser is kept for
 * the process; a missing one is looked for again on every call, so the user
 * does not restart Pi after the install. Never throws.
 */
export async function checkPlaywright(): Promise<PlaywrightCheck> {
  if (chromiumFound) return { ready: true };
  try {
    const { chromium } = await import('playwright-core');
    if (existsSync(chromium.executablePath())) {
      chromiumFound = true;
      return { ready: true };
    }
    return { ready: false, message: playwrightSetupText() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ready: false, message: `${playwrightSetupText()}\n(Playwright check failed: ${detail})` };
  }
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Validate the captured rows. A payload that lost a field the router reads
 * fails closed: the sync keeps the previous store instead of silently
 * dropping a capability minimum's evidence.
 */
export function parseSiteModels(raw: unknown): AASiteModel[] {
  if (!Array.isArray(raw) || raw.length < MIN_SITE_ROWS) {
    throw new Error(`Artificial Analysis models page changed shape: expected at least ${MIN_SITE_ROWS} models`);
  }
  const rows: AASiteModel[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (typeof row.slug !== 'string' || !row.slug || typeof row.name !== 'string') continue;
    for (const field of ['briefcaseRubricPassRate', 'lcr', 'mmmuPro', 'terminalBench40']) {
      if (row[field] != null && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0 || row[field] > 1)) {
        throw new Error(`Artificial Analysis models page changed scale: ${field} must be in [0, 1]`);
      }
    }
    rows.push({
      slug: row.slug,
      name: row.name,
      ...(typeof row.intelligenceIndexIsEstimated === 'boolean'
        ? { intelligenceIndexIsEstimated: row.intelligenceIndexIsEstimated }
        : {}),
      omniscience: finite(row.omniscience),
      lcr: finite(row.lcr),
      mmmuPro: finite(row.mmmuPro),
      briefcaseRubricPassRate: finite(row.briefcaseRubricPassRate),
      intelligenceIndexTimePerTask: finite(row.intelligenceIndexTimePerTask),
      terminalBench40: finite(row.terminalBench40),
      // Optional metric: a missing or malformed value gives no output-token
      // evidence and does not fail the sync.
      ...outputTokens(row.intelligenceIndexOutputTokensPerTask),
    });
  }
  const fields = ['intelligenceIndexIsEstimated', 'omniscience', 'briefcaseRubricPassRate', 'intelligenceIndexTimePerTask', 'lcr', 'mmmuPro', 'terminalBench40'] as const;
  const missing = fields.filter((field) => !rows.some((row) => row[field] != null));
  if (rows.length < MIN_SITE_ROWS || missing.length > 0) {
    throw new Error(
      `Artificial Analysis models page changed shape: ${rows.length} usable models` +
      (missing.length > 0 ? `, no values for ${missing.join(', ')}` : ''),
    );
  }
  return rows;
}

export async function fetchSiteModels(): Promise<AASiteModel[] & { indexVersion?: string }> {
  const check = await checkPlaywright();
  if (!check.ready) throw new Error(check.message);
  const { chromium } = await import('playwright-core');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Chromium for Playwright could not start: ${detail}\n${playwrightSetupText()}`);
  }
  try {
    const page = await browser.newPage();
    await page.addInitScript((minRows: number) => {
      const scope = globalThis as unknown as { __pi8AaModels?: unknown[] };
      const parse = JSON.parse;
      JSON.parse = function (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
        const value = parse.call(JSON, text, reviver);
        const models = (value as { models?: unknown } | null)?.models;
        if (scope.__pi8AaModels == null && Array.isArray(models) && models.length >= minRows) {
          scope.__pi8AaModels = models;
        }
        return value;
      };
    }, MIN_SITE_ROWS);
    await page.goto(AA_SITE_PAGE, { waitUntil: 'domcontentloaded', timeout: AA_SITE_TIMEOUT_MS });
    await page.waitForFunction(
      () => (globalThis as unknown as { __pi8AaModels?: unknown }).__pi8AaModels != null,
      undefined,
      { timeout: AA_SITE_TIMEOUT_MS },
    );
    // Pick the read fields inside the page so only they cross the protocol.
    const raw = await page.evaluate(() =>
      ((globalThis as unknown as { __pi8AaModels: Array<Record<string, unknown>> }).__pi8AaModels).map((m) => ({
        slug: m.slug,
        name: m.name,
        intelligenceIndexIsEstimated: m.intelligenceIndexIsEstimated,
        omniscience: m.omniscience,
        lcr: m.lcr,
        mmmuPro: m.mmmuPro,
        briefcaseRubricPassRate: (m.briefcaseBreakdown as { rubricPassRate?: unknown } | null | undefined)?.rubricPassRate,
        intelligenceIndexTimePerTask: m.intelligenceIndexTimePerTask,
        terminalBench40: m.terminalBench40,
        intelligenceIndexOutputTokensPerTask: m.intelligenceIndexOutputTokensPerTask,
      })),
    );
    // The version label comes from the same page load as the payload.
    const labels = await page.evaluate(() =>
      [...document.body.innerText.matchAll(/Intelligence Index v\d+(?:\.\d+)*/g)].map((match) => match[0]),
    );
    const indexVersion = parseSiteIndexVersion(labels);
    return Object.assign(parseSiteModels(raw), indexVersion ? { indexVersion } : {});
  } finally {
    await browser.close();
  }
}
