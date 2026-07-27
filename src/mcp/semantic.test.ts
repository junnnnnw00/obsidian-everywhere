import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_MODEL, type Embedder } from "../index/embeddings.js";
import { VaultEngine } from "../vault-engine.js";
import { getRelated, semanticSearch } from "./tools.js";

/**
 * Deterministic, dependency-free stand-in for the real transformers.js
 * embedder: a bag-of-character-trigrams vector, hashed into fixed buckets
 * and L2-normalized. It has no real semantic understanding, but cosine
 * similarity between two texts correlates with how much surface vocabulary
 * they share -- enough to test ranking/wiring (storage, staleness,
 * budgeting, cascade delete) without loading the real model or touching the
 * network in CI. See DECISIONS.md D20.
 */
function fakeEmbedder(dim = 32): Embedder {
  return async (texts) =>
    texts.map((text) => {
      const vec = new Float32Array(dim);
      const lower = text.toLowerCase();
      for (let i = 0; i < lower.length - 2; i++) {
        const tri = lower.slice(i, i + 3);
        let h = 0;
        for (const ch of tri) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
        vec[h % dim] += 1;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
      return vec;
    });
}

describe("semantic search and get_related(method: semantic)", () => {
  let tmpVault: string;
  let engine: VaultEngine;
  let passageEmbedCalls: number;

  beforeEach(async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-semantic-"));
    writeFileSync(path.join(tmpVault, "Cats.md"), "Cats are small domesticated feline pets that purr.");
    writeFileSync(path.join(tmpVault, "Dogs.md"), "Dogs are loyal domesticated canine pets that bark.");
    writeFileSync(
      path.join(tmpVault, "Quantum Physics.md"),
      "Quantum mechanics describes subatomic particle behavior.",
    );
    mkdirSync(path.join(tmpVault, "Sub"), { recursive: true });
    writeFileSync(path.join(tmpVault, "Sub", "More Cats.md"), "Kittens are baby cats, also small feline pets.");

    passageEmbedCalls = 0;
    const embedder = fakeEmbedder();
    const countingEmbedder: Embedder = async (texts, kind) => {
      if (kind === "passage") passageEmbedCalls += texts.length;
      return embedder(texts, kind);
    };
    engine = new VaultEngine({ vaultDir: tmpVault, dbPath: ":memory:", embedder: countingEmbedder });
    await engine.init();
  });

  afterEach(async () => {
    await engine.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it("semantic_search ranks lexically/semantically closer notes higher and embeds incrementally", async () => {
    const result = await semanticSearch(engine, { query: "small furry feline pet" });
    expect(result).toContain("Semantic Search Results");
    const catsIdx = result.indexOf("Cats.md");
    const moreCatsIdx = result.indexOf("More Cats.md");
    const quantumIdx = result.indexOf("Quantum Physics.md");
    expect(catsIdx).toBeGreaterThan(-1);
    expect(moreCatsIdx).toBeGreaterThan(-1);
    expect(quantumIdx).toBeGreaterThan(-1);
    // Both cat notes should rank above the unrelated physics note.
    expect(result.indexOf("## [[Cats.md")).toBeLessThan(result.indexOf("## [[Quantum Physics.md"));
    // One batched passage-embed call covering all four notes.
    expect(passageEmbedCalls).toBe(4);
  });

  it("ensureEmbeddingsFresh bounds itself to the given budget and reports what's left", async () => {
    // Only 1 of the 4 notes gets embedded; 3 remain pending.
    const first = await engine.ensureEmbeddingsFresh(1);
    expect(first).toEqual({ embedded: 1, remaining: 3 });

    const second = await engine.ensureEmbeddingsFresh(50);
    expect(second).toEqual({ embedded: 3, remaining: 0 });

    // Nothing left to do -- the embedder isn't called again.
    const callsBefore = passageEmbedCalls;
    const third = await engine.ensureEmbeddingsFresh(50);
    expect(third).toEqual({ embedded: 0, remaining: 0 });
    expect(passageEmbedCalls).toBe(callsBefore);
  });

  it("semantic_search respects the folder filter", async () => {
    const result = await semanticSearch(engine, { query: "cats", folder: "Sub" });
    expect(result).toContain("More Cats.md");
    expect(result).not.toContain("[[Cats.md");
  });

  it("semantic_search rejects an empty query", async () => {
    expect(await semanticSearch(engine, { query: "   " })).toContain("Error: query must not be empty");
  });

  it("re-embeds a note after its content changes, not before", async () => {
    await semanticSearch(engine, { query: "warm up embeddings" });
    expect(passageEmbedCalls).toBe(4); // all four notes, first time

    // Re-running against unchanged content shouldn't re-embed any notes.
    await semanticSearch(engine, { query: "warm up embeddings" });
    expect(passageEmbedCalls).toBe(4);

    writeFileSync(path.join(tmpVault, "Cats.md"), "Cats now also chase mice and climb trees.");
    engine.indexFileNow("Cats.md");
    await semanticSearch(engine, { query: "warm up embeddings" });
    // Exactly the changed note (Cats.md) was re-embedded.
    expect(passageEmbedCalls).toBe(5);
  });

  it("get_related(method: semantic) finds the topically closest note without shared tags/links", async () => {
    const result = await getRelated(engine, { path: "Cats", method: "semantic" });
    expect(result).toContain("Related to Cats.md");
    expect(result).toContain("Sub/More Cats.md");
    // The unrelated physics note should not outrank the other cat note.
    const moreCatsIdx = result.indexOf("Sub/More Cats.md");
    const quantumIdx = result.indexOf("Quantum Physics.md");
    if (quantumIdx !== -1) expect(moreCatsIdx).toBeLessThan(quantumIdx);
  });

  it("get_related defaults to the jaccard method, unaffected by embeddings", async () => {
    // The fixture notes share no tags/links, so jaccard correctly finds
    // nothing -- the point here is that it does NOT fall back to semantic
    // similarity (which would find Sub/More Cats.md) just because an
    // embedder is configured.
    const result = await getRelated(engine, { path: "Cats" });
    expect(result).toContain("No similar notes found (based on shared tags/neighbors");
    expect(result).not.toContain("embedding similarity");
  });

  it("cascades embedding deletion when the underlying note is deleted", async () => {
    await semanticSearch(engine, { query: "pets" });
    const fileId = engine.db.getFileByPath("Cats.md")!.id;
    expect(engine.db.getEmbedding(fileId, EMBEDDING_MODEL)).toBeDefined();

    engine.deleteFileNow("Cats.md");
    expect(engine.db.getEmbedding(fileId, EMBEDDING_MODEL)).toBeUndefined();
  });
});
