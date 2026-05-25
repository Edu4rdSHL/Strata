# Architecture

In-depth companion to [`README.md`](README.md). Covers how Strata is put
together and the trade-offs at each layer.

## Design goals

1. Never block the GNOME Shell main loop.
2. Never lose history. SQLite WAL, atomic upserts, daemon supervisor.
3. Heavy work lives in Rust; the extension only renders UI and forwards
   events.
4. Mime allowlist, size caps, password-manager opt-out, no shell exec,
   no markup parsing of clipboard content.

## Topology

```
+---------------------------- GNOME Shell process (GJS) ---------------------------+
|                                                                                  |
|   Meta.Selection --> extension.js --> dbus.js (Gio.DBusProxy) ---+               |
|                                                                  |               |
|   panel.js <----------- ui/clipboardItem.js <--------------------+               |
|        ^                                                                         |
|        | ItemAdded / ItemDeleted / HistoryCleared                                |
+--------+-------------------------------------------------------------------------+
         |
         | session D-Bus (org.gnome.Strata)
         v
+----------------------- strata-daemon (Rust process) --------------------------+
|                                                                               |
|   zbus interface --> tokio executor --> spawn_blocking --> rusqlite (Mutex)   |
|                              |                                  |             |
|                              |                                  v             |
|                              |                       +---------------------+  |
|                              |                       | SQLite (WAL, FTS5)  |  |
|                              |                       +---------------------+  |
|                              v                                                |
|                   image::load_from_memory --> PNG thumbnail (~256 px)         |
|                                                                               |
+-------------------------------------------------------------------------------+
```

## Process model

### Separate daemon

GJS is single-threaded and shares its main loop with the entire GNOME Shell
compositor. Any synchronous syscall, hash computation, or SQLite query in
JS can freeze the desktop. Strata moves all of it across a process
boundary. The cost is one IPC hop per operation; D-Bus is shared-memory
fast on the same machine, and the extension never `await`s anything in the
hot ingest path (it fires `SubmitItem` and returns immediately).

### Daemon supervisor

`extension.js` owns the daemon. On enable it `Gio.Subprocess.spawnv`s
`bin/strata-daemon` and registers a watchdog:

- If the child exits, schedule a respawn with exponential backoff
  (1 s, 2 s, 4 s, capped at 30 s).
- After 5 rapid restarts within 60 s, stop and surface a notification.
- On disable, send `Shutdown` over D-Bus first, then `SIGTERM` if it
  doesn't exit within 2 s.

### Startup

The extension listens for `notify::g-name-owner` on the D-Bus proxy. When
the daemon's `org.gnome.Strata` name becomes owned, the panel triggers
its initial fetch. No polling, no fixed delays.

## Ingest path

```
Meta.Selection.OwnerChanged
    |
    +-- _readClipboard()
        |
        +-- _pickMime() enforces strict allowlist
        +-- skip if x-kde-passwordManagerHint present
        +-- Meta.Selection.transfer_async() --> Uint8Array
        +-- SubmitItemAsync(mime, rawBytes)  (D-Bus 'ay')
                |
                v
        daemon::dbus_service::submit_item(mime, Vec<u8>)
                |
                +-- spawn_blocking(move || {
                       hash = blake3(bytes)
                       upsert by content_hash (returns existing id or new)
                       on new image: decode + thumbnail
                       emit ItemAdded
                       prune to max_history
                          +-- emit ItemDeleted per pruned id
                    })
```

### Content hash

`blake3` for dedup. A unique index on `content_hash` makes the upsert
atomic: copying the same content twice updates `created_at` instead of
creating a duplicate row.

### Wire format

`SubmitItem` takes `ay` (D-Bus byte array) directly. No base64 encoding
in JS, no decode step in Rust.

### Mime allowlist

`Meta.Selection.transfer_async` reads the full clipboard payload into GJS
memory before any size check is possible, so the only safe defence
against a hostile or buggy app putting a 1 GB blob on the clipboard is to
refuse mime types we don't recognise. The list lives in
`extension.js::_pickMime` and `daemon::main::pick_mime` and covers the
common text and image types. Password-manager hint mimes
(`x-kde-passwordManagerHint`) are skipped on both paths.

## Storage

### Schema

```sql
CREATE TABLE clipboard_history (
    id              TEXT PRIMARY KEY,    -- UUID v4
    mime_type       TEXT NOT NULL,
    content_text    TEXT,                -- one of these two is populated
    content_blob    BLOB,                -- (text vs binary)
    thumbnail_blob  BLOB,                -- pre-decoded PNG, ~256 px
    content_hash    TEXT NOT NULL,       -- blake3 of raw bytes
    source_app      TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX        idx_created_at ON clipboard_history (created_at DESC);
CREATE UNIQUE INDEX idx_hash       ON clipboard_history (content_hash);

CREATE VIRTUAL TABLE clipboard_fts USING fts5(
    content_text,
    content='clipboard_history',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);
-- plus AI / AD / AU triggers keeping FTS in sync with the base table.
```

### PRAGMAs

```
journal_mode = WAL        -- readers don't block the writer
synchronous  = NORMAL     -- fsync on commit, not on every write
foreign_keys = ON
```

### FTS5 search

Full-text index over `content_text` only. Images and other binaries are
not indexed; an empty search shows everything, a non-empty search shows
only matching text items.

`tokenize='unicode61 remove_diacritics 2'` gives O(log n) prefix search
and matches across diacritics (searching `cafe` finds `café`).

The FTS5 table uses `content='clipboard_history'` (external content), so
text is stored once in the base table and FTS5 holds only the inverted
index.

### FTS5 query construction

User input is split into whitespace tokens. Each token has embedded `"`
doubled (FTS5 escape) and is wrapped in `"..."` with a `*` prefix
suffix:

```
input:  cafe hello
tokens: ["cafe", "hello"]
FTS5:   "cafe"* "hello"*
```

The constructed string is bound as a parameter value (`?N`), not
interpolated into SQL. A malformed FTS5 escape can only affect the
search query, not the SQL parser.

### Pruning

`upsert_item` checks `COUNT(*) > max_history` after each insert and
deletes the oldest excess rows by `created_at ASC`, returning their ids.
The D-Bus layer emits `ItemDeleted` for each so the extension can unlink
the matching `~/.cache/strata/thumbnails/<id>.png`.

## Concurrency

The Rust daemon runs `tokio::main(flavor = "multi_thread")`. zbus
dispatches each incoming method call on the executor. rusqlite is sync,
so every DB call is wrapped:

```rust
let conn = self.conn.clone();
tokio::task::spawn_blocking(move || {
    let guard = conn.lock();   // poison-recovering wrapper
    db::upsert_item(&guard, ...)
}).await?
```

The D-Bus reactor stays responsive while disk I/O runs on the blocking
pool. One mutex serialises writers (SQLite is single-writer in WAL). The
lock wrapper takes the inner value even if a previous holder panicked,
so a single bad task can't poison the global state.

## Memory bounds

- Mime allowlist gates which payloads are even read.
- Text and image size caps are user-configurable (defaults 1 MB and 5 MB).
  Payloads larger than the configured cap are rejected at `submit_item`
  before storage. The extension reads the caps from GSettings and pushes
  them to the daemon via `SetConfig`, so changes apply at runtime.
- Thumbnails are decoded once at ingest, stored as PNG. The UI fetches
  them lazily via `GetThumbnail(id) -> ay` only for visible rows.
- History pagination uses the configurable `page-size` setting (default
  50). The panel loads one page on open and one more each time the
  scroll reaches the bottom. The full table never sits in JS memory.

## Lazy loading

Two independent lazy layers keep the panel responsive regardless of
history size.

### Paginated history

`GetHistory(offset, limit)` returns metadata only (id, mime, short text
preview, timestamp). The panel loads `page-size` rows on open, then
another page each time the scroll position passes ~80 % of the viewport.
The Rust side serves these from the `idx_created_at DESC` index with
`LIMIT/OFFSET`, which stays O(log n) for any history size.

Search shortcuts this path: when the search box is non-empty the panel
calls `SearchHistory(query, limit)` instead and disables scroll-driven
appends, so an in-progress search and a scroll event cannot race.

### On-demand thumbnails

`GetHistory` does not return image bytes. For each image row,
`ui/clipboardItem.js` builds the row with a placeholder icon and then:

1. Checks `~/.cache/strata/thumbnails/<id>.png`. If present, loads from
   disk via `St.Icon` with a `file://` URI.
2. Otherwise calls `GetThumbnail(id)`, which returns the
   pre-decoded PNG bytes the daemon stored in `thumbnail_blob` at
   ingest time. The bytes are written to the cache file, then loaded.
3. On `ItemDeleted` (including prune-driven deletes), the cache file is
   unlinked.

Effect: scrolling past 1000 image rows costs zero D-Bus traffic for the
rows above and below the viewport. Each thumbnail is fetched at most
once per process lifetime; reopens after the first fetch read the PNG
straight from the page cache.

The daemon does the expensive part (image decode + resize) exactly once,
at ingest, on the blocking pool. The UI never decodes a full-resolution
image.

## UI invariants

- `St.Label({ text: ... })` only. No `set_markup`, so clipboard content
  can never inject Pango markup.
- List updates are batched via `GLib.idle_add` in chunks of 20.
- Search has a 150 ms debounce and an epoch counter; stale responses
  that arrive after a newer query are dropped.
- Paste-back uses `St.Clipboard.set_text` for text or
  `Meta.SelectionSourceMemory.new` + `set_owner` for binary. No code
  path in Strata executes clipboard content (no `spawn`, no
  `launch_uri`, no `show_uri`).

## Wayland clipboard monitor

The daemon contains a `wl-clipboard-rs` monitor for `ext-data-control-v1`
and `zwlr-data-control-v1`. GNOME's Mutter does not expose either, so on
GNOME the monitor logs INFO and all ingest comes from GJS via
`Meta.Selection` + `SubmitItem`.

The monitor is kept because it makes the daemon usable standalone on
wlroots-based compositors (Sway, Hyprland) with a non-GNOME front-end,
and it is small and isolated.

## Security boundary

| Boundary | Threat | Mitigation |
|---|---|---|
| App to clipboard | Huge blob OOMs Shell | Mime allowlist, size caps |
| App to history | Password leak | `x-kde-passwordManagerHint` opt-out |
| User to search | SQL injection | rusqlite `params![]`, FTS5 input bound as value |
| Daemon to FS | Path traversal via id | Ids are server-generated UUID v4 |
| Daemon to extension | Signal spoofing | D-Bus enforces single owner of `org.gnome.Strata` |
| Stored item to paste | Command execution | No spawn, no launch_uri, no markup parsing |

## Non-GNOME front-end

The daemon's D-Bus interface is the contract:

1. Spawn `strata-daemon`.
2. Subscribe to `ItemAdded`, `ItemDeleted`, `HistoryCleared`.
3. Call `GetHistory`, `SearchHistory`, `SetClipboard`, etc.
4. On wlroots compositors either let the built-in `wl-clipboard-rs`
   monitor handle ingest, or read the clipboard yourself and call
   `SubmitItem(mime, bytes)`.

See `busctl` examples in [`strata-daemon/README.md`](strata-daemon/README.md).
