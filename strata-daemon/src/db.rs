use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Metadata for a clipboard entry - does NOT include thumbnail bytes.
/// Thumbnails are fetched separately via `get_thumbnail` for lazy loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemMeta {
    pub id: String,
    pub mime_type: String,
    /// Non-null for text types (truncated preview for display).
    pub content_text: Option<String>,
    pub source_app: Option<String>,
    pub created_at: i64,
    /// True if this item has a stored thumbnail (clients should call get_thumbnail to fetch it).
    pub has_thumbnail: bool,
}

/// A row as stored in SQLite (blob is raw bytes, not base64).
#[allow(dead_code)]
pub struct RawItem {
    pub id: String,
    pub mime_type: String,
    pub content_text: Option<String>,
    pub content_blob: Option<Vec<u8>>,
    pub thumbnail_blob: Option<Vec<u8>>,
    pub source_app: Option<String>,
    pub created_at: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

/// Acquire the DB lock, transparently recovering from poison.
///
/// A mutex is "poisoned" when a thread panics while holding it. For our SQLite
/// connection this is safe to recover from because rusqlite uses RAII statements
/// and transactions - any in-flight statement or transaction has already been
/// rolled back by the time the panic unwinds past it. Without this recovery,
/// a single panic anywhere in the daemon would permanently break ALL future
/// database access (every subsequent .lock().unwrap() would panic too).
fn lock_conn(m: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            tracing::warn!("DB mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("Opening SQLite database at {:?}", path))?;

        // Performance pragmas: WAL mode for concurrent reads, synchronous=NORMAL is safe
        // for a clipboard history (we can tolerate losing the last item on a crash).
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous   = NORMAL;
             PRAGMA foreign_keys  = ON;",
        )?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS clipboard_history (
                id            TEXT PRIMARY KEY,
                mime_type     TEXT NOT NULL,
                content_text  TEXT,
                content_blob  BLOB,
                thumbnail_blob BLOB,
                content_hash  TEXT NOT NULL,
                source_app    TEXT,
                created_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_created_at ON clipboard_history (created_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_hash ON clipboard_history (content_hash);",
        )?;

        // Migration: add thumbnail_blob column to existing databases.
        conn.execute_batch("ALTER TABLE clipboard_history ADD COLUMN thumbnail_blob BLOB;")
            .ok(); // Silently ignore error if column already exists.

        // FTS5 full-text search index over content_text only.
        // Images and other non-text items are NOT indexed - search filters
        // them out (an empty search shows everything; a non-empty search
        // shows only matching text items).
        //
        // External-content table linked by rowid avoids duplicating the text.
        // unicode61 with diacritic removal gives reasonable matching for
        // European languages (e.g. searching "cafe" finds "café").
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5(
                content_text,
                content='clipboard_history',
                content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TRIGGER IF NOT EXISTS clipboard_ai AFTER INSERT ON clipboard_history BEGIN
                INSERT INTO clipboard_fts(rowid, content_text)
                VALUES (new.rowid, new.content_text);
            END;
            CREATE TRIGGER IF NOT EXISTS clipboard_ad AFTER DELETE ON clipboard_history BEGIN
                INSERT INTO clipboard_fts(clipboard_fts, rowid, content_text)
                VALUES('delete', old.rowid, old.content_text);
            END;
            CREATE TRIGGER IF NOT EXISTS clipboard_au AFTER UPDATE ON clipboard_history BEGIN
                INSERT INTO clipboard_fts(clipboard_fts, rowid, content_text)
                VALUES('delete', old.rowid, old.content_text);
                INSERT INTO clipboard_fts(rowid, content_text)
                VALUES (new.rowid, new.content_text);
            END;",
        )?;

        // Backfill FTS index from any pre-existing rows. Cheap no-op if already in sync.
        let _ = conn.execute_batch("INSERT INTO clipboard_fts(clipboard_fts) VALUES('rebuild');");

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert or promote (bump `created_at`) a duplicate item.
    /// Returns `(id, is_new)`.
    pub fn upsert_item(
        &self,
        mime_type: &str,
        content_text: Option<&str>,
        content_blob: Option<&[u8]>,
        thumbnail_blob: Option<&[u8]>,
        content_hash: &str,
        source_app: Option<&str>,
    ) -> Result<(String, bool)> {
        let conn = lock_conn(&self.conn);
        let now_ms = chrono_now_ms();

        // Check for existing item with this hash.
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM clipboard_history WHERE content_hash = ?1",
                params![content_hash],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            conn.execute(
                "UPDATE clipboard_history SET created_at = ?1 WHERE id = ?2",
                params![now_ms, id],
            )?;
            return Ok((id, false));
        }

        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO clipboard_history
               (id, mime_type, content_text, content_blob, thumbnail_blob, content_hash, source_app, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, mime_type, content_text, content_blob, thumbnail_blob, content_hash, source_app, now_ms],
        )?;
        Ok((id, true))
    }

    /// Return a page of recent items as metadata (no thumbnail bytes).
    /// `offset` is from the most recent item (0 = newest).
    pub fn get_history_page(
        &self,
        offset: usize,
        limit: usize,
        max_history: usize,
    ) -> Result<Vec<ItemMeta>> {
        let conn = lock_conn(&self.conn);
        let effective_limit = limit.min(max_history.saturating_sub(offset));
        if effective_limit == 0 {
            return Ok(Vec::new());
        }

        let mut stmt = conn.prepare(
            "SELECT id, mime_type, content_text, source_app, created_at,
                    thumbnail_blob IS NOT NULL AS has_thumb
             FROM clipboard_history
             ORDER BY created_at DESC
             LIMIT ?1 OFFSET ?2",
        )?;

        let items = stmt
            .query_map(params![effective_limit as i64, offset as i64], |row| {
                Ok(ItemMeta {
                    id: row.get(0)?,
                    mime_type: row.get(1)?,
                    content_text: row.get(2)?,
                    source_app: row.get(3)?,
                    created_at: row.get(4)?,
                    has_thumbnail: row.get::<_, i64>(5)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(items)
    }

    /// Full-text search over content_text. Only text items can match - images
    /// and other non-text content are NOT indexed and never appear in results.
    /// Empty query returns []; callers should use get_history_page for that.
    pub fn search_history(&self, query: &str, limit: usize) -> Result<Vec<ItemMeta>> {
        let conn = lock_conn(&self.conn);

        // Build a safe FTS5 prefix query: each token quoted + '*' suffix for prefix match.
        let tokens: Vec<String> = query
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| {
                // Escape embedded double-quotes by doubling them per FTS5 syntax.
                let escaped = t.replace('"', "\"\"");
                format!("\"{}\"*", escaped)
            })
            .collect();

        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let fts_query = tokens.join(" ");

        let mut stmt = conn.prepare(
            "SELECT h.id, h.mime_type, h.content_text, h.source_app, h.created_at,
                    h.thumbnail_blob IS NOT NULL AS has_thumb
             FROM clipboard_history h
             WHERE h.rowid IN (SELECT rowid FROM clipboard_fts WHERE clipboard_fts MATCH ?1)
             ORDER BY h.created_at DESC
             LIMIT ?2",
        )?;

        let items = stmt
            .query_map(params![fts_query, limit as i64], |row| {
                Ok(ItemMeta {
                    id: row.get(0)?,
                    mime_type: row.get(1)?,
                    content_text: row.get(2)?,
                    source_app: row.get(3)?,
                    created_at: row.get(4)?,
                    has_thumbnail: row.get::<_, i64>(5)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(items)
    }

    /// Fetch a single item's thumbnail bytes. Returns None if the item has no thumbnail
    /// (text item, or doesn't exist).
    pub fn get_thumbnail(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let conn = lock_conn(&self.conn);
        let blob: Option<Option<Vec<u8>>> = conn
            .query_row(
                "SELECT thumbnail_blob FROM clipboard_history WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        Ok(blob.flatten())
    }

    /// Fetch raw item content for clipboard write-back.
    pub fn get_raw_item(&self, id: &str) -> Result<Option<RawItem>> {
        let conn = lock_conn(&self.conn);
        let result = conn.query_row(
            "SELECT id, mime_type, content_text, content_blob, thumbnail_blob, source_app, created_at
             FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| {
                Ok(RawItem {
                    id: row.get(0)?,
                    mime_type: row.get(1)?,
                    content_text: row.get(2)?,
                    content_blob: row.get(3)?,
                    thumbnail_blob: row.get(4)?,
                    source_app: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        ).ok();
        Ok(result)
    }

    pub fn delete_item(&self, id: &str) -> Result<bool> {
        let conn = lock_conn(&self.conn);
        let n = conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn clear_history(&self) -> Result<()> {
        let conn = lock_conn(&self.conn);
        conn.execute_batch("DELETE FROM clipboard_history;")?;
        Ok(())
    }

    /// Prune history to `max_history` most recent items. Returns the IDs of
    /// items that were deleted, so the caller can emit ItemDeleted signals
    /// (lets clients clean up per-item caches like thumbnail files).
    pub fn prune(&self, max_history: usize) -> Result<Vec<String>> {
        let conn = lock_conn(&self.conn);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM clipboard_history", [], |row| {
            row.get(0)
        })?;
        if (count as usize) <= max_history {
            return Ok(Vec::new());
        }
        // Collect IDs to delete with a single ORDER BY pass.
        let mut stmt = conn.prepare(
            "SELECT id FROM clipboard_history
             WHERE id NOT IN (
                 SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT ?1
             )",
        )?;
        let ids: Vec<String> = stmt
            .query_map(params![max_history as i64], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        // Delete by collected IDs so the ORDER BY subquery runs only once.
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "DELETE FROM clipboard_history WHERE id IN ({})",
            placeholders
        );
        conn.execute(&sql, rusqlite::params_from_iter(ids.iter()))?;
        Ok(ids)
    }
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
