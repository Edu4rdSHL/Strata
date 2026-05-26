# Strata GNOME Shell extension

The GJS front-end for [Strata](../README.md). Renders the panel UI and forwards
clipboard events to [`strata-daemon`](../strata-daemon/README.md) over D-Bus.

> The extension requires `strata-daemon` to be installed and available in
> `$PATH`. See the [main README](../README.md) for install instructions.
> The extension is **pure JavaScript** - no binary is bundled.
>
> **Compatibility:** Only tested on GNOME Shell 50. The `metadata.json`
> declares support for 45–50 since the APIs used (`Meta.Selection`,
> `St`, `Gio`, `Adw`) have been stable across that range, but older
> versions are untested. If you try one and it works, open an issue to
> let us know.

## File layout

```
strata@edu4rdshl.dev/
├── extension.js       Lifecycle, daemon lookup/supervisor, clipboard ingest
├── prefs.js           Preferences window
├── dbus.js            Generated D-Bus proxy + interface XML
├── stylesheet.css     Panel styles
├── metadata.json      GNOME Shell metadata (tested on Shell 50; declares 45–50)
├── schemas/           GSettings schema (max history, size caps, shortcut)
└── ui/
    ├── panel.js       Popup panel: pagination, search, scroll-to-load
    └── clipboardItem.js  Per-item row (text preview or lazy thumbnail)
```

## How it works

1. On enable, `extension.js` checks if the D-Bus name is already owned
   (daemon running via systemd). If not, it looks for `strata-daemon` in
   `$PATH` and spawns it, auto-respawning on crash with exponential backoff.
2. `Meta.Selection` notifies us of every clipboard change. We read the raw
   bytes (allowlisted mimes only, password-manager hint skipped) and ship
   them to the daemon via `SubmitItem(s, ay)`.
3. The daemon dedups, stores, indexes, and emits `ItemAdded`.
4. `ui/panel.js` paginates history with `GetHistory`, debounces search with
   `SearchHistoryAsync`, and writes back via `St.Clipboard.set_text` or
   `Meta.SelectionSourceMemory` (never `spawn`, never `launch_uri`).

## Settings

Open with `gnome-extensions prefs strata@edu4rdshl.dev`:

**History**
- **Max history** (50–2000 items)
- **Items per page** (20–200, rows fetched on open and on each scroll-to-bottom)
- **Maximum text size** (1–100 MB, larger items are not stored)
- **Maximum image size** (1–100 MB, larger items are not stored)

**Appearance**
- **Theme** (Automatic / Light / Dark; Automatic follows the system light/dark preference)
- **Panel width** (pixels)
- **Panel max height** (pixels, list scrolls past this)
- **Move activated item to top**
- **Panel position** (top-left, top-center, top-right)

**Keyboard**
- **Open Strata** shortcut

**Privacy**
- **App exclusions** (apps whose clipboard is never recorded)

All four history/size limits are pushed to the daemon over D-Bus (`SetConfig`) as soon
as you change them. No restart needed.

## Develop

```sh
# Build daemon + install extension + recompile schemas
make -C .. install-daemon && make -C .. install

# Live-reload logs
journalctl --user -f /usr/bin/gnome-shell | grep -i strata
```

If you only change JS, you can re-`make install` and restart the Shell
(Wayland: log out / in; X11: `Alt+F2`, `r`).

## License

GPL-3.0-or-later.
