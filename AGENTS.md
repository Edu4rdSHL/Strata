# AGENTS.md

Guidelines for AI agents working on this codebase.

## Repository layout

```
strata-daemon/          Rust daemon (tokio, zbus, rusqlite)
strata@edu4rdshl.dev/   GNOME Shell extension (GJS) - pure JS, no binary
  schemas/              GSettings schema XML
  ui/                   Panel and item widgets
contrib/systemd/        systemd user service unit for distro packaging
ARCHITECTURE.md         In-depth design document
```

## Core principle

"JS draws, Rust thinks." The extension must never block the GNOME Shell
compositor. All heavy work (hashing, storage, search, thumbnails) lives in
the daemon. The extension only renders and forwards events.

## Build

```bash
# Build daemon + compile schemas
make

# Install daemon binary to ~/.local/bin (must be in PATH)
make install-daemon

# Install extension to ~/.local/share/gnome-shell/extensions/
make install
```

## Lint

```bash
cargo clippy --manifest-path=strata-daemon/Cargo.toml
```

No linter is configured for GJS. Follow the existing code style.

## Deploy to a test VM

```bash
# Build and copy daemon binary to VM
cargo build --release --manifest-path=strata-daemon/Cargo.toml
scp strata-daemon/target/release/strata-daemon fedoradev:~/.local/bin/

# Sync extension (JS only)
rsync -a strata@edu4rdshl.dev/ fedoradev:~/.local/share/gnome-shell/extensions/strata@edu4rdshl.dev/ --exclude='.git'
ssh fedoradev 'glib-compile-schemas ~/.local/share/gnome-shell/extensions/strata@edu4rdshl.dev/schemas/'
# Then log out and back in (Wayland) or Alt+F2 r (X11)
```

## Key files

| File | Purpose |
|---|---|
| `strata-daemon/src/main.rs` | Entry point, Wayland monitor, GJS submit task, `process_change`/`process_bytes` |
| `strata-daemon/src/dbus_service.rs` | D-Bus interface, `Limits` struct, all D-Bus methods |
| `strata-daemon/src/db.rs` | SQLite schema, FTS5, insert, prune, search, thumbnail |
| `strata-daemon/src/config.rs` | Data dir, DB path (`~/.local/share/strata/clipboard.db`) |
| `strata@edu4rdshl.dev/extension.js` | Daemon lifecycle (PATH lookup + systemd detection), clipboard ingest, focus tracking, `_pushConfig` |
| `strata@edu4rdshl.dev/ui/panel.js` | Popup panel, lazy-load pagination, search, `_pageSize`, theme class toggle (`_applyTheme`) |
| `strata@edu4rdshl.dev/stylesheet.css` | Dark theme (default, auto-loaded by GNOME) |
| `strata@edu4rdshl.dev/light.css` | Light theme overrides, scoped under `.strata-theme-light` |
| `strata@edu4rdshl.dev/ui/clipboardItem.js` | Individual row widget |
| `strata@edu4rdshl.dev/prefs.js` | Preferences window (Adw) |
| `strata@edu4rdshl.dev/dbus.js` | D-Bus proxy definition and XML interface |
| `contrib/systemd/strata-daemon.service` | systemd user unit for distro packaging |

## D-Bus interface summary

Service `org.gnome.Strata`, object `/org/gnome/Strata`, interface `org.gnome.Strata.Manager`.

Methods: `GetHistory(offset u32, limit u32) -> json s`,
`SearchHistory(query s, limit u32) -> json s`,
`GetThumbnail(id s) -> png_bytes ay`,
`GetItemContent(id s) -> (mime_type s, content ay)`,
`SetClipboard(id s)`, `DeleteItem(id s)`, `ClearHistory()`,
`SetConfig(max_history u32, max_text_bytes u32, max_image_bytes u32)`,
`SubmitItem(mime s, data ay)`, `Shutdown()`.

Signals: `ItemAdded(id s, mime_type s, preview s)`, `ItemDeleted(id s)`, `HistoryCleared()`.

## GSettings keys

`max-history`, `page-size`, `max-text-mb`, `max-image-mb`, `theme`, `panel-position`,
`panel-width`, `panel-max-height`, `keyboard-shortcut`, `move-activated-to-top`,
`excluded-apps`.

`theme` is `auto`/`light`/`dark`. `auto` follows `org.gnome.desktop.interface
color-scheme`. Light styling lives in `light.css`, scoped under a
`.strata-theme-light` class the panel toggles on its root box; `extension.js`
loads/unloads `light.css` via the St theme context. New non-`stylesheet.css`
CSS files must be added to the `pack` target as `--extra-source` (only
`stylesheet.css` is auto-included by `gnome-extensions pack`).

## Conventions

- No `--` em-dashes, no emojis in code comments or docs.
- Rust: use `tracing::info!`, `tracing::warn!`, `tracing::error!` (qualified path, not bare imports). No `println!` in daemon code.
- GJS: `console.log('[Strata] ...')` / `console.error('[Strata] ...')` prefix for all extension logs.
- Size limits travel as bytes over D-Bus. MB conversion happens extension-side.
- `Ordering::Relaxed` is intentional on `Arc<AtomicUsize>` limits (advisory, not critical path).
- Never execute clipboard content. Writes go through `wl-clipboard-rs` (`copy_multi`) in the daemon, never via shell subprocess or `eval`.
- Excluded apps list is checked before storing any clipboard item.
- Ingest paths are mutually exclusive by environment: on GNOME the monitor cannot bind (Mutter exposes neither data-control protocol) so ingest is GJS `SubmitItem`; on wlroots the built-in monitor is the path.
- List queries (`get_history_page`, `search_history`) return `content_text` truncated to `PREVIEW_CHARS` via `substr`; full content is served only by `GetItemContent` for paste-back.
