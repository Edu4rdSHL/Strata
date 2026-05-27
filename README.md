# Strata

A fast, stutter-free clipboard manager for GNOME Shell.

All heavy work (hashing, decoding, storage, search, thumbnails) lives in a Rust
daemon. The GNOME Shell extension only renders UI and forwards events over
D-Bus, so the compositor is never blocked, even with thousands of items.

## Architecture

Strata is **two components**, and you need **both** for it to work:

| Component | Language | Role |
|---|---|---|
| [`strata-daemon/`](strata-daemon/) | Rust + tokio + zbus | Storage (SQLite + FTS5), dedup, thumbnails, D-Bus service `dev.edu4rdshl.Strata` |
| [`strata@edu4rdshl.dev/`](strata@edu4rdshl.dev/) | GJS (GNOME Shell extension) | Top-bar panel, search UI, paste-back, clipboard ingest |

The extension auto-connects to the daemon on enable. If the daemon is managed
by systemd (or another init system), the extension detects it and skips
spawning its own copy. If no daemon is running, the extension looks for
`strata-daemon` in `$PATH` and spawns it directly.

```
GNOME Shell (GJS)  ──D-Bus──▶  strata-daemon  ──▶  SQLite (~/.local/share/strata)
                                       │
                                       └──▶  thumbnails (~/.cache/strata)
```

## Requirements

- GNOME Shell 50 (tested). May work on 45–49 but untested — if you try it and it works, please open an issue to let us know.
- `strata-daemon` binary in `$PATH` (see Install below)
- Rust 1.74+ (build only)
- `glib-compile-schemas` (from `glib2-devel` / `libglib2.0-dev-bin`)
- SQLite is bundled via `rusqlite`, no system dep needed

## Install

### Arch Linux (AUR)

Strata is split into a daemon package and an extension package; install both.
Two channels are available -- pick one channel and don't mix them:

- **Stable (tagged releases):** `strata-daemon` + `gnome-shell-extension-strata`
- **Git (latest `main`):** `strata-daemon-git` + `gnome-shell-extension-strata-git`

```sh
# Stable
paru -S strata-daemon gnome-shell-extension-strata

# or Git
paru -S strata-daemon-git gnome-shell-extension-strata-git
```

(Use your AUR helper of choice, e.g. `yay` instead of `paru`.) Then log out /
log back in (Wayland) or `Alt+F2` → `r` (X11) and enable:

```sh
gnome-extensions enable strata@edu4rdshl.dev
```

The daemon is installed to `/usr/bin/strata-daemon` (already in `$PATH`), so
the extension finds it automatically.

### From source (local build)

```sh
git clone https://github.com/Edu4rdSHL/Strata.git
cd Strata

# Build and install the daemon binary to ~/.local/bin
make install-daemon

# Install the GNOME Shell extension
make install
```

Make sure `~/.local/bin` is in your `$PATH`, then log out / log back in
(Wayland) or `Alt+F2` → `r` (X11) and enable:

```sh
gnome-extensions enable strata@edu4rdshl.dev
```

### Via systemd user service (distro packages / manual)

Distro packages install the daemon binary to `/usr/bin/strata-daemon` and
the systemd unit from `contrib/systemd/strata-daemon.service` to
`/usr/lib/systemd/user/`. Enable it once:

```sh
systemctl --user enable --now strata-daemon
```

Then install and enable the extension as above. The extension detects the
running daemon and will not spawn a second copy.

### Pack for extensions.gnome.org

```sh
make pack          # produces strata@edu4rdshl.dev.shell-extension.zip (JS only)
```

## Uninstall

```sh
gnome-extensions disable strata@edu4rdshl.dev
rm -rf ~/.local/share/gnome-shell/extensions/strata@edu4rdshl.dev
rm -rf ~/.local/share/strata ~/.cache/strata    # also wipes history
```

## Other desktops?

The daemon is desktop-agnostic. It speaks plain D-Bus and runs anywhere
the session bus does. Any client (KDE applet, CLI tool, your own script)
can drive it. See [`strata-daemon/README.md`](strata-daemon/README.md) for
the wire protocol and a `busctl` example.

The shipped UI is a GNOME Shell extension. Ports to other desktops only
need a new front-end against the same D-Bus interface.

## Deeper reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design goals, process model,
  storage schema, FTS5 details, concurrency, security boundary.
- [`strata-daemon/README.md`](strata-daemon/README.md): D-Bus interface
  reference and standalone usage.
- [`strata@edu4rdshl.dev/README.md`](strata@edu4rdshl.dev/README.md):
  extension internals.

## AI Policy Disclosure

Parts of this codebase and documentation were written with the assistance of AI tools. This is the policy we follow and will continue to follow: every line of code and every document produced with AI assistance is rigorously reviewed by a human before being published. No AI-generated output is committed without understanding, verification, and approval by the project author.

## License

GPL-3.0-or-later.
