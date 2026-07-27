export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  title TEXT,
  is_markdown INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  hash TEXT NOT NULL,
  frontmatter_json TEXT,
  raw_content TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_raw TEXT NOT NULL,
  target_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('wikilink','embed','markdown')),
  heading TEXT,
  block_id TEXT,
  alias TEXT,
  line INTEGER,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id);
CREATE INDEX IF NOT EXISTS idx_links_target_raw ON links(target_raw);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('inline','frontmatter')),
  line INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tags_file ON tags(file_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  alias TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_file ON aliases(file_id);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);

CREATE TABLE IF NOT EXISTS headings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  text TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_headings_file ON headings(file_id);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_file ON blocks(file_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path, title, content, tokenize='unicode61'
);

-- Supplements files_fts for CJK text: unicode61 tokenizes on word
-- boundaries, so it can't match a substring inside a Korean/Chinese/Japanese
-- compound "word" (those scripts don't use spaces between words). Trigram
-- indexes every 3-character sequence instead, so it can find e.g. "그래프"
-- inside "그래프이론". Kept as a separate table (not a replacement) since
-- trigram can't match queries under 3 characters and changes relevance
-- ranking in ways that would regress normal word-based search -- see
-- VaultDB.search and DECISIONS.md D9.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts_trigram USING fts5(
  path, title, content, tokenize='trigram'
);

-- One row per markdown file, computed lazily/on-demand (not during
-- fullScan/watch) -- see VaultEngine.ensureEmbeddingsFresh and
-- DECISIONS.md D20. The model column lets a future model change be
-- detected and re-embedded rather than silently mixing incompatible vectors.
CREATE TABLE IF NOT EXISTS embeddings (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
