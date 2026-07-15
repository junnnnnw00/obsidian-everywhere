# Decisions

Format: Decision / Reason / Alternatives considered

---

## D1. ESM + NodeNext module resolution
**Decision:** `"type": "module"`, `moduleResolution: NodeNext`, all relative imports use `.js` extensions in TS source.
**Reason:** `@modelcontextprotocol/sdk` ships ESM-first; avoids dual-package hazard.
**Alternatives:** CommonJS — rejected, fights the SDK's module format.

## D2. Frontmatter parser: gray-matter
**Decision:** Use `gray-matter` (wraps js-yaml) for frontmatter extraction.
**Reason:** Battle-tested, preserves the raw YAML block for round-tripping, gives arbitrary-field passthrough for free.
**Alternatives:** Hand-rolled `---` splitter + `js-yaml` directly — more code for no benefit since gray-matter already exposes the parsed object and raw content split.

## D3. Fixture vault duplicate-name resolution semantics
**Decision:** For an unqualified link `[[Same Name]]` matching multiple files, resolve by (1) shortest path depth, (2) alphabetical full-path tie-break.
**Reason:** Approximates Obsidian's real "shortest path when possible" behavior without needing Obsidian's exact undocumented tie-break algorithm. Documented as a fixture test case (`Ambiguous Resolution Test.md`) so behavior is explicit and testable rather than guessed at silently.
**Alternatives:** First-match-in-directory-scan-order — rejected as non-deterministic across filesystems/OS.

## D4. Attachment files (non-markdown) tracked in index, not treated as "notes"
**Decision:** `Attachments/diagram.png` is indexed as a resolvable embed target but is not a `note` row with parsed content.
**Reason:** §3 requires `![[image.png]]` to resolve and be typed as an `embed` edge; the target doesn't need markdown parsing.
**Alternatives:** Ignore non-markdown files entirely — rejected, would make embed resolution always "unresolved" for images, contradicting real vault behavior.

## D5. Default exclude rules: `.obsidian/`, `.git/`, `node_modules/`
**Decision:** These three are excluded by default; attachment folders are NOT excluded by default (configurable) since embeds need to resolve against them.
**Reason:** Matches spec §3.9 ("설정 가능") — .obsidian is always noise, attachments are legitimate graph targets.
**Alternatives:** Exclude a hardcoded "Attachments/" folder — rejected, too vault-specific to hardcode.
