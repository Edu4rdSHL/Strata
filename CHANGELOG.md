# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.5.0] - 2026-05-26

### Added

- Light/dark theme support. A new **Theme** preference (Automatic / Light /
  Dark) controls the panel palette; Automatic follows the system
  `org.gnome.desktop.interface color-scheme`. The dark theme is unchanged.
  Light styling lives in `light.css`, scoped under a `.strata-theme-light`
  class toggled on the panel root box, loaded into the St theme context by
  the extension. Switching is a single class toggle with no runtime cost on
  the ingest/render paths.

### Fixed

- The keyboard shortcut now hides the panel when it is already open. The
  binding was registered without `Shell.ActionMode.POPUP`, so while the
  panel's modal grab was active the second press was swallowed and
  `toggle()` never ran.
- The search placeholder ("Search...") is now legible in the light theme; it
  previously inherited a light-on-dark Shell color.

### Packaging

- `make pack` now bundles `light.css` (`--extra-source`); only
  `stylesheet.css` is auto-included by `gnome-extensions pack`.

---

## [0.4.0] - 2026-05-26

### Performance

- `GetHistory` / `SearchHistory` now truncate `content_text` to a preview
  (`substr`, ~200 chars) in SQL instead of returning the full payload. A
  page of large text items previously serialized up to megabytes of JSON
  over D-Bus and parsed it on the GJS main loop, only to render a 140-char
  snippet. Full content is still served on demand by `GetItemContent`.

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
