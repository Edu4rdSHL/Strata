/* extension.js - Strata extension lifecycle. */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { StrataProxy, BUS_NAME, OBJECT_PATH } from './dbus.js';
import { StrataPanel } from './ui/panel.js';

export default class StrataExtension extends Extension {
    /** @type {Gio.Subprocess | null} */
    _daemon = null;
    _daemonSpawnTime = 0;
    _daemonRestartAttempts = 0;
    _shuttingDown = false;
    _daemonRestartTimerId = null;

    /** @type {StrataPanel | null} */
    _panel = null;
    /** @type {object | null} Gio.DBusProxy instance */
    _proxy = null;

    _itemAddedId = null;
    _itemDeletedId = null;
    _historyClearedId = null;

    /** @type {number | null} focused-window signal connection ID */
    _focusSignalId = null;

    /** @type {string} WM class of the currently focused app (lower-cased) */
    _currentFocusedApp = '';

    /** @type {object | null} PanelMenu.Button indicator */
    _indicator = null;

    /** @type {number | null} Meta.Selection owner-changed signal ID */
    _selectionChangedId = null;

    /** @type {number | null} Debounce timer for clipboard reads */
    _clipboardDebounceId = null;

    /** True while a transfer_async is in flight - prevents concurrent transfers. */
    _clipboardTransferPending = false;

    /** @type {string[]} Apps to exclude from history */
    _excludedApps = [];
    _pendingSignalId = null;

    /** @type {boolean} Re-entrancy guard for signal processing */
    #busy = false;

    /** @type {number | null} Keyboard shortcut binding ID */
    _shortcutId = null;

    enable() {
        this._shuttingDown = false;
        this._daemonRestartAttempts = 0;

        this._settings = this.getSettings();
        this._excludedApps = this._settings.get_strv('excluded-apps');
        this._settings.connect('changed::excluded-apps', () => {
            this._excludedApps = this._settings.get_strv('excluded-apps');
        });

        this._readSizeLimits();
        this._configChangedIds = [
            this._settings.connect('changed::max-history',  () => { this._readSizeLimits(); this._pushConfig(); }),
            this._settings.connect('changed::max-text-mb',  () => { this._readSizeLimits(); this._pushConfig(); }),
            this._settings.connect('changed::max-image-mb', () => { this._readSizeLimits(); this._pushConfig(); }),
        ];

        // 1. Top-bar indicator icon.
        this._addIndicator();

        // 2. Spawn the Rust daemon.
        this._spawnDaemon();

        // 3. Connect D-Bus proxy (async - doesn't block if daemon isn't ready yet).
        this._connectProxy();

        // 4. Track focused window (lightweight - no clipboard I/O).
        this._connectFocusTracking();

        // 5. Monitor clipboard via Meta.Selection (GNOME-native, no Wayland protocol needed).
        this._connectClipboardMonitor();

        // 6. Register keyboard shortcut.
        this._registerShortcut();
    }

    disable() {
        // Signal the watchdog NOT to respawn on exit.
        this._shuttingDown = true;
        if (this._daemonRestartTimerId !== null) {
            GLib.Source.remove(this._daemonRestartTimerId);
            this._daemonRestartTimerId = null;
        }
        // Clean up in reverse order.
        this._unregisterShortcut();
        this._disconnectClipboardMonitor();
        this._disconnectFocusTracking();
        this._disconnectSignals();
        if (this._proxyOwnerId && this._proxy) {
            this._proxy.disconnect(this._proxyOwnerId);
            this._proxyOwnerId = 0;
        }
        if (this._configChangedIds && this._settings) {
            for (const id of this._configChangedIds) this._settings.disconnect(id);
            this._configChangedIds = null;
        }
        this._panel?.destroy();
        this._panel = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._stopDaemon();
        this._proxy = null;
        this._settings = null;
    }


    _addIndicator() {
        // dontCreateMenu = true so PanelMenu.Button doesn't open an empty popup.
        this._indicator = new PanelMenu.Button(0.0, 'Strata', true);
        const icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        this._indicator.connect('button-press-event', () => {
            this._panel?.toggle();
            return false; // EVENT_PROPAGATE
        });
        Main.panel.addToStatusArea('strata', this._indicator);
    }


    _connectClipboardMonitor() {
        const selection = global.display.get_selection();
        this._selectionChangedId = selection.connect('owner-changed', (_sel, type) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            this._scheduleClipboardRead();
        });
    }

    _disconnectClipboardMonitor() {
        // Cancel any pending debounce timer and reset the in-flight guard so
        // the next enable() cycle starts clean.
        if (this._clipboardDebounceId !== null) {
            GLib.Source.remove(this._clipboardDebounceId);
            this._clipboardDebounceId = null;
        }
        this._clipboardTransferPending = false;
        if (this._selectionChangedId !== null) {
            global.display.get_selection().disconnect(this._selectionChangedId);
            this._selectionChangedId = null;
        }
    }

    /** Debounce entry point - coalesces rapid clipboard changes (e.g. from
     *  apps that write clipboard multiple times per operation). */
    _scheduleClipboardRead() {
        if (this._clipboardDebounceId !== null) {
            GLib.Source.remove(this._clipboardDebounceId);
            this._clipboardDebounceId = null;
        }
        this._clipboardDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._clipboardDebounceId = null;
            this._readClipboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Single in-flight transfer at a time - prevents queuing multiple concurrent
     *  transfer_async + base64_encode operations that would stall the main thread. */
    _readClipboard() {
        if (this._clipboardTransferPending) return;
        const selection = global.display.get_selection();
        const mimes = selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
        // Password managers (KeePassXC, KeePass, some Bitwarden builds) mark
        // copied secrets with this hint mime. Honoring it lets users keep
        // their passwords out of clipboard history.
        if (mimes.includes('x-kde-passwordManagerHint')) return;
        const mime = this._pickMime(mimes);
        if (!mime) return;

        this._clipboardTransferPending = true;
        const outputStream = Gio.MemoryOutputStream.new_resizable();
        selection.transfer_async(
            Meta.SelectionType.SELECTION_CLIPBOARD,
            mime,
            -1,
            outputStream,
            null,
            (_obj, result) => {
                this._clipboardTransferPending = false;
                try {
                    selection.transfer_finish(result);
                    outputStream.close(null);
                    const bytes = outputStream.steal_as_bytes();
                    const size = bytes.get_size();
                    if (size === 0) return;
                    const MAX_TEXT  = this._maxTextBytes;
                    const MAX_IMAGE = this._maxImageBytes;
                    if (size > (mime.startsWith('image/') ? MAX_IMAGE : MAX_TEXT)) return;
                    // Send raw bytes as a D-Bus `ay` so we avoid blocking
                    // synchronous base64 work on the GJS main thread.
                    this._proxy?.SubmitItemRemote(mime, bytes.get_data(), () => {});
                } catch (e) {
                    console.error('[Strata] Clipboard read error:', e.message);
                }
            }
        );
    }

    /** Pick the best MIME type to store from the offered list (mirrors Rust pick_mime). */
    _pickMime(mimes) {
        const PREFERRED = [
            // Raster images (size-capped at MAX_IMAGE).
            'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
            'image/bmp', 'image/tiff', 'image/avif', 'image/x-icon',
            'image/svg+xml',
            // Plain text (UTF-8 preferred, then locale, then X11 legacy aliases).
            // Ranked above rich-text so editors that expose both text/plain and
            // text/html give us raw source, not styled markup.
            'text/plain;charset=utf-8', 'UTF8_STRING',
            'text/plain', 'STRING', 'TEXT',
            // Rich text -- only reached when no plain-text offer is available.
            'text/html',
            'text/rtf', 'application/rtf',
            'text/markdown',
            // File-manager copy/cut payloads (URI list, not bytes).
            'x-special/gnome-copied-files',
            'x-special/nautilus-clipboard',
            'application/x-kde-cutselection',
            'text/uri-list',
        ];
        for (const want of PREFERRED)
            if (mimes.includes(want)) return want;
        // Allowlist only: see comment in pick_mime (daemon). Reading unknown
        // mime types could pull a 1 GB blob into Shell memory before we can
        // size-check it.
        return null;
    }


    _spawnDaemon() {
        if (this._shuttingDown) return;

        // Check if a daemon is already running (e.g. via systemd user service).
        // If the D-Bus name is already owned we must not spawn a second instance.
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner',
            new GLib.Variant('(s)', [BUS_NAME]),
            null, Gio.DBusCallFlags.NONE, 2000, null,
            (_conn, result) => {
                try {
                    _conn.call_finish(result);
                    // Name already owned - daemon managed externally (systemd etc).
                    console.log('[Strata] daemon already running, skipping spawn');
                } catch (_) {
                    // Name not owned - spawn it ourselves.
                    this._doSpawnDaemon();
                }
            }
        );
    }

    _doSpawnDaemon() {
        if (this._shuttingDown) return;
        const daemonPath = GLib.find_program_in_path('strata-daemon');
        if (!daemonPath) {
            console.error(
                '[Strata] strata-daemon not found in PATH. ' +
                'Install the strata-daemon package or place the binary in your PATH.'
            );
            this._notifyDaemonMissing();
            return;
        }
        try {
            this._daemon = new Gio.Subprocess({
                argv: [daemonPath],
                flags: Gio.SubprocessFlags.NONE,
            });
            this._daemon.init(null);
            this._daemonSpawnTime = GLib.get_monotonic_time() / 1000; // ms
            this._daemon.wait_async(null, () => this._onDaemonExited());
        } catch (e) {
            console.error('[Strata] Failed to spawn daemon:', e);
            this._scheduleDaemonRestart();
        }
    }

    _notifyDaemonMissing() {
        try {
            const source = new imports.ui.messageTray.Source({
                title: 'Strata',
                icon: new St.Icon({ icon_name: 'edit-paste-symbolic' }),
            });
            Main.messageTray.add(source);
            const notification = new imports.ui.messageTray.Notification({
                source,
                title: 'Strata: daemon not found',
                body: 'Install the strata-daemon package to enable clipboard history.',
                urgency: imports.ui.messageTray.Urgency.HIGH,
            });
            source.addNotification(notification);
        } catch (_) {
            // Message tray may not be available (e.g. during early startup) - already logged above.
        }
    }

    _onDaemonExited() {
        if (!this._daemon) return; // shutdown initiated by _stopDaemon
        const exit = this._daemon.get_exit_status();
        const lifetimeMs = (GLib.get_monotonic_time() / 1000) - this._daemonSpawnTime;
        this._daemon = null;

        if (this._shuttingDown) {
            console.log(`[Strata] daemon exited cleanly during shutdown (status=${exit})`);
            return;
        }

        // Reset attempt counter if the daemon ran long enough to be considered healthy.
        if (lifetimeMs >= 5000) {
            this._daemonRestartAttempts = 0;
        }
        this._daemonRestartAttempts++;
        console.error(
            `[Strata] daemon exited with status ${exit} after ${Math.round(lifetimeMs)}ms ` +
            `(restart attempt ${this._daemonRestartAttempts})`
        );

        if (this._daemonRestartAttempts > 5) {
            console.error(
                '[Strata] Daemon crashed 5 times in rapid succession - giving up. ' +
                'Disable and re-enable the extension to retry.'
            );
            return;
        }
        this._scheduleDaemonRestart();
    }

    _scheduleDaemonRestart() {
        if (this._shuttingDown) return;
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const backoffMs = 1000 * Math.pow(2, Math.max(0, this._daemonRestartAttempts - 1));
        console.log(`[Strata] respawning daemon in ${backoffMs}ms`);
        this._daemonRestartTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, backoffMs, () => {
            this._daemonRestartTimerId = null;
            this._spawnDaemon();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopDaemon() {
        if (!this._daemon) return;
        // Capture reference immediately so the timer doesn't kill a newly-spawned daemon.
        const daemonToStop = this._daemon;
        this._daemon = null;
        try {
            // Graceful shutdown via D-Bus first.
            this._proxy?.ShutdownRemote(() => {});
        } catch (_) {}
        // Give it 1.5s then force-terminate.
        GLib.timeout_add(GLib.PRIORITY_LOW, 1500, () => {
            try { daemonToStop.send_signal(15); } catch (_) {} // SIGTERM
            return GLib.SOURCE_REMOVE;
        });
    }


    _connectProxy() {
        try {
            this._proxy = new StrataProxy(
                Gio.DBus.session,
                BUS_NAME,
                OBJECT_PATH,
                (proxy, error) => {
                    if (error) {
                        console.error('[Strata] D-Bus proxy error:', error);
                        return;
                    }
                    this._connectSignals();
                    this._panel = new StrataPanel(proxy, this._settings, this._indicator);
                    // Push config now if the daemon is already up, and
                    // again on every owner transition so a respawned
                    // daemon picks up the latest values.
                    this._pushConfig();
                    this._proxyOwnerId = proxy.connect('notify::g-name-owner',
                        () => { if (proxy.g_name_owner) this._pushConfig(); });
                }
            );
        } catch (e) {
            console.error('[Strata] Failed to create D-Bus proxy:', e);
        }
    }

    /** Read size limits from GSettings into instance fields (bytes). */
    _readSizeLimits() {
        this._maxHistory     = this._settings.get_int('max-history');
        this._maxTextBytes   = this._settings.get_int('max-text-mb')  * 1024 * 1024;
        this._maxImageBytes  = this._settings.get_int('max-image-mb') * 1024 * 1024;
    }

    /** Push runtime limits to the daemon. Safe to call before the proxy
     *  is ready or after the daemon has gone away. */
    _pushConfig() {
        this._proxy?.SetConfigRemote(
            this._maxHistory,
            this._maxTextBytes,
            this._maxImageBytes,
            () => {}
        );
    }

    _connectSignals() {
        this._itemAddedId = Gio.DBus.session.signal_subscribe(
            BUS_NAME,
            'org.gnome.Strata.Manager',
            'ItemAdded',
            OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onItemAdded.bind(this)
        );

        this._itemDeletedId = Gio.DBus.session.signal_subscribe(
            BUS_NAME,
            'org.gnome.Strata.Manager',
            'ItemDeleted',
            OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [id] = params.deepUnpack();
                // Best-effort: unlink the on-disk thumbnail file (if any).
                // GLib.unlink returns -1 if file doesn't exist; we ignore that.
                try {
                    const cachePath =
                        `${GLib.get_user_cache_dir()}/strata/thumbnails/${id}.png`;
                    GLib.unlink(cachePath);
                } catch (_) { /* not all items have thumbnails - fine */ }
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._panel?.removeItem(id);
                    return GLib.SOURCE_REMOVE;
                });
            }
        );

        this._historyClearedId = Gio.DBus.session.signal_subscribe(
            BUS_NAME,
            'org.gnome.Strata.Manager',
            'HistoryCleared',
            OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                // Wipe all on-disk thumbnails when daemon clears history.
                try {
                    const dir = `${GLib.get_user_cache_dir()}/strata/thumbnails`;
                    const d = Gio.File.new_for_path(dir);
                    if (d.query_exists(null)) {
                        const en = d.enumerate_children(
                            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
                        let info;
                        while ((info = en.next_file(null))) {
                            try { d.get_child(info.get_name()).delete(null); } catch (_) {}
                        }
                        en.close(null);
                    }
                } catch (e) { console.error('[Strata] cache clear failed:', e); }
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._panel?.clearItems();
                    return GLib.SOURCE_REMOVE;
                });
            }
        );
    }

    _disconnectSignals() {
        if (this._itemAddedId !== null) {
            Gio.DBus.session.signal_unsubscribe(this._itemAddedId);
            this._itemAddedId = null;
        }
        if (this._itemDeletedId !== null) {
            Gio.DBus.session.signal_unsubscribe(this._itemDeletedId);
            this._itemDeletedId = null;
        }
        if (this._historyClearedId !== null) {
            Gio.DBus.session.signal_unsubscribe(this._historyClearedId);
            this._historyClearedId = null;
        }
        if (this._pendingSignalId !== null) {
            GLib.Source.remove(this._pendingSignalId);
            this._pendingSignalId = null;
        }
    }


    _onItemAdded(_conn, _sender, _path, _iface, _signal, params) {
        // Debounce: if the daemon emits a burst, coalesce into one update.
        if (this._pendingSignalId !== null) {
            GLib.Source.remove(this._pendingSignalId);
            this._pendingSignalId = null;
        }
        this._pendingSignalId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._pendingSignalId = null;
            this._processItemAdded(params).catch(e => console.error('[Strata] ItemAdded error:', e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _processItemAdded(params) {
        if (this.#busy) return;
        this.#busy = true;
        try {
            const [id, mimeType, preview] = params.deepUnpack();

            // Exclusion check - no clipboard I/O, just string comparison.
            if (this._isExcluded(this._currentFocusedApp)) {
                try {
                    await this._proxy.DeleteItemAsync(id);
                } catch (e) {
                    // ignore - item may already be gone
                }
                return;
            }

            // Defer UI mutation to after the current frame renders.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._panel?.prependItem(id, mimeType, preview);
                return GLib.SOURCE_REMOVE;
            });
        } finally {
            this.#busy = false;
        }
    }

    _isExcluded(appClass) {
        if (!appClass) return false;
        return this._excludedApps.some(ex => appClass.includes(ex.toLowerCase()));
    }


    _connectFocusTracking() {
        this._focusSignalId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            this._currentFocusedApp = (win?.get_wm_class() ?? '').toLowerCase();
            // Inform the daemon (best-effort, ignore failures).
            this._proxy?.SetFocusedAppRemote(this._currentFocusedApp, () => {});
        });
    }

    _disconnectFocusTracking() {
        if (this._focusSignalId !== null) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = null;
        }
    }


    _registerShortcut() {
        Main.wm.addKeybinding(
            'keyboard-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._panel?.toggle()
        );
    }

    _unregisterShortcut() {
        Main.wm.removeKeybinding('keyboard-shortcut');
    }
}
