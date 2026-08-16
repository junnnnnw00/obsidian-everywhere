declare module "@huggingface/transformers" {
  export const env: { cacheDir: string };
  export function pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<any>;
}
