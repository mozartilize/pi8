import type { BenchModel, ExtensionContext } from '../types.js';
import { loadConfig } from '../config.js';
import * as artificialAnalysis from './artificial-analysis.js';
import * as benchlm from './benchlm.js';

export type AdapterName = 'artificial-analysis' | 'benchlm';

export interface AdapterConfig {
  'artificial-analysis': {
    apiKey?: string;
  };
  'benchlm': Record<string, never>;
}

export interface Adapter {
  name: AdapterName;
  isAvailable(config: AdapterConfig): boolean;
  fetch(config: AdapterConfig): Promise<Omit<BenchModel, 'registryId' | 'active'>[]>;
}

const artificialAnalysisAdapter: Adapter = {
  name: 'artificial-analysis',
  isAvailable: (config) => Boolean(config['artificial-analysis']?.apiKey),
  fetch: (config) => artificialAnalysis.fetchAndNormalize({ apiKey: config['artificial-analysis']?.apiKey }),
};

// BenchLM's AA-Omniscience Index page is public — no key, no auth. Keeping it
// available by default means a sync without an AA key still lands knowledge
// rows instead of failing outright.
const benchlmAdapter: Adapter = {
  name: 'benchlm',
  isAvailable: () => true,
  fetch: () => benchlm.fetchAndNormalize({}),
};

export const ADAPTERS: Adapter[] = [
  artificialAnalysisAdapter,
  benchlmAdapter,
];

export function getEnabledAdapters(
  sourceNames: AdapterName[],
  config: AdapterConfig,
): Adapter[] {
  return ADAPTERS.filter(
    (a) => sourceNames.includes(a.name) && a.isAvailable(config),
  );
}

export function buildAdapterConfig(ctx?: ExtensionContext): AdapterConfig {
  // Precedence: explicit ctx override (tests) > env var > persisted config.
  const fromCtx = (ctx as unknown as { artificialAnalysisApiKey?: string } | undefined)
    ?.artificialAnalysisApiKey;
  const fromEnv = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  let fromDisk: string | undefined;
  try {
    fromDisk = loadConfig().artificialAnalysisApiKey;
  } catch {
    // Unreadable config must not break sync; the adapter reports the missing key.
  }
  return {
    'artificial-analysis': { apiKey: fromCtx || fromEnv || fromDisk },
    'benchlm': {},
  };
}

export { artificialAnalysis, benchlm };
