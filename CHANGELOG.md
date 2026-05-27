# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.8.0] - 2026-05-26

### Changed

- Upgraded daemon dependencies: zbus 4 -> 5, rusqlite 0.31 -> 0.40, dirs 5 -> 6.

### Fixed

- Single-instance daemon: the bus name is now requested with `DoNotQueue`
  instead of `ReplaceExisting | AllowReplacement`. If the name is already owned
  the daemon exits cleanly instead of (a) running without owning it (zbus 5
  returns `InQueue` as `Ok`) or (b) stealing the name and leaving the previous
  instance running as an orphan (zbus does not terminate a replaced owner).
- Real SQLite errors are no longer swallowed as "not found": `upsert_item`'s
  dedup lookup and `get_thumbnail` / `get_raw_item` now distinguish a missing
  row (`Ok(None)`) from a genuine error (propagated), via `optional()`.
- Daemon supervisor: a guard prevents spawning two daemons when an in-flight
  name-owner check overlaps a backoff retry, and the exit handler ignores
  foreign/stale subprocess exits so restart accounting can't be corrupted.
- Panel: clearing history (or a `HistoryCleared` signal) now invalidates the
  active search snapshot, so scrolling can't render stale rows; the
  scroll-into-view idle is guarded against a destroyed panel.

### Internal

- clippy pedantic/nursery cleanup across the daemon (format args, redundant
  clone, pass-by-reference, doc backticks), with `#[allow]` + rationale for the
  intentional lints (the single-writer lock hold, zbus interface `async`).

---

## [0.7.0] - 2026-05-26

### Fixed

- Theme stylesheet reload no longer recurses. `load_stylesheet` itself emits
  the St theme context's `changed` signal, so reloading `light.css` on every
  `changed` fed back into itself and hit "too much recursion" - flooding the
  journal and spinning the CPU on screen unlock (which restyles widgets and
  fires `changed`). `light.css` is now loaded once and the `changed`
  subscription is removed entirely. (Dark/light switching is unaffected - it is
  the panel's class toggle, not this load. A GNOME Shell *theme* switch no
  longer auto-re-applies the sheet; that is recoverable by re-enabling.)

### Changed

- **BREAKING (D-Bus): the service was renamed from `org.gnome.Strata` to
  `dev.edu4rdshl.Strata`.** The `org.gnome.*` namespace is reserved for
  official GNOME software; Strata is a third-party project, so it now uses the
  reverse-DNS of its own domain (matching the `strata@edu4rdshl.dev` UUID).
  Bus name, object path (`/dev/edu4rdshl/Strata`), and interface
  (`dev.edu4rdshl.Strata.Manager`) all changed. The bundled daemon and
  extension are updated together; only external `busctl` scripts or non-GNOME
  front-ends that hard-coded the old name need updating. The GSettings schema
  (`org.gnome.shell.extensions.strata`) is unchanged - that namespace is the
  correct convention for GNOME Shell extension settings.

---

## [0.6.0] - 2026-05-26

### Added

- Lazy, full-history search. Search now covers the entire stored history (up
  to `max-history`) instead of an arbitrary 500-result cap, and renders a page
  at a time as you scroll instead of building every match at once. Results are
  snapshotted once and paged from memory, so scrolling never re-queries.

### Fixed

- Images other than PNG/JPEG (GIF, WebP, BMP, TIFF, ICO) were silently dropped
  because the daemon could not decode them. They are now decoded and stored.
  AVIF and SVG are no longer accepted (not decodable here), rather than
  accepted-then-dropped.
- Search no longer "blinks" (paints an empty list) between keystrokes; the
  first page renders in the same frame as the clear.
- Search render race conditions: a fast new query can no longer be blocked by a
  superseded render, render a previous query's stale results, or leave a pruned
  item behind as a phantom row on scroll.
- `ItemAdded` preview length now matches the history/search queries (200
  chars), so a just-copied row and the same row after a reload show the same
  text.
- Deterministic ordering for items that share a millisecond timestamp
  (`created_at DESC, rowid DESC`), so pruning can't evict the wrong one.
- Lowering **max history** now prunes stored items immediately instead of
  waiting for the next copy.
- Extension lifecycle: the `excluded-apps` settings handler and the daemon
  force-kill timer are now released on disable; the exclusion-path delete is
  null-guarded.
- The daemon requests its bus name with `AllowReplacement` for a clean hand-off
  on extension reload; the Wayland monitor clears stale offers on clipboard
  clear.

### Changed

- Image rows show a generic "Image" label instead of singling out PNG.

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
