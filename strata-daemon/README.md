# strata-daemon

The Rust backend for [Strata](../README.md). Speaks D-Bus, stores history in
SQLite, generates image thumbnails, and indexes text for full-text search.

It is **not GNOME-specific**. Any D-Bus client can use it.

## Build

```sh
cargo build --release
# binary at target/release/strata-daemon
```

The GNOME extension spawns this binary automatically; you only need to run it
manually if you're using a non-GNOME front-end.

## Storage

| Path | Contents |
|---|---|
| `~/.local/share/strata/clipboard.db` | History DB (WAL mode, FTS5 index) |
| `~/.cache/strata/thumbnails/<id>.png` | Per-item image thumbnails |

## D-Bus interface

- **Bus name:** `dev.edu4rdshl.Strata`
- **Object path:** `/dev/edu4rdshl/Strata`
- **Interface:** `dev.edu4rdshl.Strata.Manager`

| Member | Signature | Notes |
|---|---|---|
| `SubmitItem` (method) | `(s ay) → ()` | Ingest a clipboard payload (mime, raw bytes) |
| `GetHistory` (method) | `(u u) → s` | `(offset, limit)` → JSON array |
| `SearchHistory` (method) | `(s u) → s` | FTS5 query → JSON array |
| `GetThumbnail` (method) | `s → ay` | PNG bytes for item id |
| `GetItemContent` (method) | `s → (ss)` | `(mime, base64)` for paste-back |
| `SetClipboard` (method) | `s → ()` | Re-copy a stored item |
| `DeleteItem` (method) | `s → ()` | |
| `ClearHistory` (method) | `() → ()` | |
| `Shutdown` (method) | `() → ()` | Graceful exit |
| `SetConfig` (method) | `(uuu) → ()` | `(max_history, max_text_bytes, max_image_bytes)`; 0 means leave unchanged |
| `ItemAdded` (signal) | `(sss)` | `(id, mime, preview)` |
| `ItemDeleted` (signal) | `s` | |
| `HistoryCleared` (signal) | `()` | |

### Example: drive it from the shell

```sh
# Start the daemon (foreground)
./target/release/strata-daemon

# In another terminal:
busctl --user call dev.edu4rdshl.Strata /dev/edu4rdshl/Strata \
       dev.edu4rdshl.Strata.Manager GetHistory uu 0 10

# Submit text:
busctl --user call dev.edu4rdshl.Strata /dev/edu4rdshl/Strata \
       dev.edu4rdshl.Strata.Manager SubmitItem say "text/plain;charset=utf-8" 5 104 101 108 108 111

# Listen for new items:
busctl --user monitor dev.edu4rdshl.Strata
```

## Supported clipboard payloads

Strict mime allowlist. Per-type size caps default to 1 MB for text and
5 MB for images; both are runtime-configurable via the `SetConfig`
D-Bus method (the GNOME extension wires this to its GSettings).

- Text: `text/plain*`, `UTF8_STRING`, `STRING`, `TEXT`, `text/rtf`,
  `text/markdown`, `text/html`, `text/uri-list`, `x-special/nautilus-clipboard`,
  `application/x-kde-cutselection`, `application/rtf`
- Images: `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`,
  `image/bmp`, `image/tiff`, `image/avif`, `image/x-icon`, `image/svg+xml`

Items carrying `x-kde-passwordManagerHint` are silently dropped
(KeePassXC / Bitwarden convention).

## Module map

```
src/
├── main.rs          Entry point, clipboard ingest, mime allowlist
├── config.rs        Config loading + size caps
├── db.rs            SQLite schema, FTS5, parameterised queries
├── dbus_service.rs  zbus interface implementation
└── clipboard/
    ├── monitor.rs   Optional wl-clipboard-rs monitor (unused on GNOME)
    └── writer.rs    Paste-back helpers
```

## Tests

```sh
cargo test --release
```

## License

GPL-3.0-or-later.
