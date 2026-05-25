# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.3.0] - 2026-05-25

### Fixed

- `_notifyDaemonMissing` now uses the correct ESM `MessageTray` import;
  the missing-binary desktop notification was previously silently swallowed
  by a `catch` block due to a `ReferenceError` on the legacy `imports.ui.*` path.
- `clearItems()` no longer double-destroys widgets: `destroy_all_children()`
  on the item list is sufficient; the preceding per-widget `destroy()` loop
  was redundant and could trigger warnings.
- Daemon now fails fast with a clear error message when the XDG data directory
  cannot be determined, instead of silently placing the database in the
  current working directory.

### Performance

- `make_thumbnail` return type simplified to `Result<Vec<u8>>`; the previously
  returned base64 string was never used at the call site.
- `prune()` now collects IDs with a single `ORDER BY` subquery, then deletes
  with `DELETE WHERE id IN (...)`, eliminating a redundant second query.
- `get_raw_item` no longer fetches `thumbnail_blob` (up to ~40 KB per row)
  when only text/binary content is needed for paste-back.
- Unnecessary clones of `WriteRequest` fields eliminated in `write_to_clipboard`.
- Hover hit-testing in the panel replaced: the previous O(n) per-widget
  bounds-check loop on every mouse-move is now O(tree-depth) via
  `event.get_source()` + parent walk, letting Clutter's own hit-test do
  the work.
- `SetFocusedApp` D-Bus call removed. The daemon stored the value but never
  read it; app exclusion runs entirely in the extension before `SubmitItem`
  is called. Eliminates one IPC round-trip on every window focus change.
- `GetItemContent` now returns raw bytes (`ay`) instead of a base64-encoded
  string (`s`). Eliminates base64 encode in the daemon and decode in GJS on
  every paste. The `base64` crate dependency has been removed entirely.

---

## [0.2.0] - 2026-05-25

### Fixed

- **MIME priority: plain text now preferred over rich text.**
  When an application (code editors, web browsers, etc.) advertises both a
  plain-text and a rich-text (`text/html`, `text/rtf`) variant on the clipboard,
  Strata now captures the plain-text variant. Previously, `text/html` ranked
  above `text/plain`, causing syntax-highlighted HTML markup to be stored
  instead of the actual source text when copying from code editors.
  Rich-text types are still captured when no plain-text alternative is offered.
  Fix applied to both the Rust daemon (`pick_mime`) and the GNOME Shell
  extension (`_pickMime`) to keep them in sync.

---

## [0.1.0] - 2026-05-24

### Added

- Initial release.
- Rust daemon (`strata-daemon`) with SQLite/FTS5 storage, Wayland clipboard
  monitor, D-Bus interface (`org.gnome.Strata`), and image thumbnail support.
- GNOME Shell extension (`strata@edu4rdshl.dev`) with popup panel, lazy-loaded
  pagination, full-text search, image thumbnails, and paste-back.
- Preferences window (Adwaita) for history size, size limits, keyboard
  shortcut, panel position/width, and excluded-app list.
- Daemon lifecycle management: extension detects an existing systemd-managed
  daemon and falls back to spawning from `PATH`; shows a desktop notification
  when the binary is not found.
- `contrib/systemd/strata-daemon.service` for distribution packaging.
- `Makefile` with `install-daemon`, `install`, and `pack` targets.
