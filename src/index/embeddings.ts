import os from "node:os";
import path from "node:path";
import type { FileRow } from "./db.js";

export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

/** transformers.js defaults to caching downloaded model files under its own node_modules folder, which npm wipes on every reinstall. Reuses the ~/.obsidian-everywhere/ convention already used for external-volume index DBs (see vault/db-path.ts) so the ~100MB model download survives reinstalls/upgrades. */
export const MODEL_CACHE_DIR = path.join(os.homedir(), ".obsidian-everywhere", "models");

export type EmbeddingKind = "query" | "passage";

/**
 * Computes embedding vectors for a batch of texts. Injectable so tests never
 * load the real model or touch the network -- see DECISIONS.md D20.
 */
export type Embedder = (texts: string[], kind: EmbeddingKind) => Promise<Float32Array[]>;

let pipelinePromise: Promise<any> | null = null;

/**
 * Lazily loads Xenova/multilingual-e5-small via transformers.js (downloaded
 * from Hugging Face and cached locally on first use) and computes
 * mean-pooled, L2-normalized sentence embeddings.
 *
 * e5 models are trained for asymmetric retrieval and require a "query: " /
 * "passage: " prefix on the input text to work as intended -- see
 * https://huggingface.co/intfloat/multilingual-e5-small. For note-to-note
 * similarity (not a search query), treat both sides as "passage" per that
 * model's own guidance for symmetric comparisons.
 */
export const defaultEmbedder: Embedder = async (texts, kind) => {
  pipelinePromise ??= import("@huggingface/transformers").then(({ env, pipeline }) => {
    env.cacheDir = MODEL_CACHE_DIR;
    // q8 (int8-quantized) instead of the ~470MB fp32 default -- ~120MB, and
    // fine for retrieval-quality embeddings (this isn't generation).
    return pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
  });
  const extractor = await pipelinePromise;
  const prefixed = texts.map((t) => `${kind}: ${t}`);
  const output = await extractor(prefixed, { pooling: "mean", normalize: true });
  const dim = output.dims[output.dims.length - 1] as number;
  const data = output.data as Float32Array;
  return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
};

/** Text a note contributes to its own embedding: title plus a length-capped content excerpt (well under the model's ~512-token context). */
export function noteEmbeddingText(file: FileRow): string {
  const title = file.title ?? "";
  const body = (file.raw_content ?? "").slice(0, 2000);
  return title ? `${title}\n\n${body}` : body;
}

/** Both embedder outputs are already L2-normalized, so the dot product equals cosine similarity. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buffer.writeFloatLE(vector[i]!, i * 4);
  return buffer;
}

/** Copies into a fresh, correctly-aligned buffer first -- a BLOB read back from better-sqlite3 isn't guaranteed to start at a 4-byte-aligned offset, which Float32Array requires. */
export function bufferToVector(buffer: Buffer): Float32Array {
  const copy = Buffer.alloc(buffer.length);
  buffer.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}
