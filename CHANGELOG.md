# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
