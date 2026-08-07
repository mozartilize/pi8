/**
 * Minimal type declarations for optional embedding dependencies.
 *
 * These packages are NOT committed dependencies. TypeScript needs their
 * shapes for the dynamic import() expressions in embedding.ts but must
 * not assume they are installed — every import() site is wrapped in
 * try/catch and degrades gracefully when the package is absent.
 */

declare module 'onnxruntime-node' {
  export class Tensor {
    constructor(type: string, data: BigInt64Array, dims: number[]);
    data: BigInt64Array;
    dims: number[];
    type: string;
    size: number;
  }

  export class InferenceSession {
    static create(
      path: string,
      options?: { executionProviders?: string[]; graphOptimizationLevel?: string },
    ): Promise<InferenceSession>;
    outputNames: string[];
    run(
      feeds: Record<string, Tensor>,
    ): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
  }

  export const env: {
    versions?: { common?: string };
  };
}

declare module '@xenova/transformers' {
  interface TransformersTokenizer {
    (
      text: string,
      options: { padding: boolean; truncation: boolean; max_length: number },
    ): {
      input_ids: { data: BigInt64Array; dims: number[] };
      attention_mask: { data: BigInt64Array; dims: number[] };
    };
  }

  export const AutoTokenizer: {
    from_pretrained(modelId: string): Promise<TransformersTokenizer>;
  };
}
