/* extension.js - Strata extension lifecycle. */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { StrataProxy, BUS_NAME, OBJECT_PATH } from './dbus.js';
import { StrataPanel } from './ui/panel.js';

function logError(label, err) {
    if (err !== undefined) {
        try { Gio.DBusError.strip_remote_error(err); } catch (_) {}
    }
    const tail = err !== undefined ? `: ${err?.message ?? err}` : '';
    console.error(`[Strata] ${label}${tail}`);
}

export default class StrataExtension extends Extension {
    /** @type {Gio.Subprocess | null} */
    _daemon = null;
    _daemonSpawnTime = 0;
    _daemonRestartAttempts = 0;
    _shuttingDown = false;
    _daemonRestartTimerId = null;
    _daemonKillTimerId = null;
    /** True while a GetNameOwner check before spawning is in flight, so an
     *  overlapping respawn attempt can't spawn a second daemon. */
    _spawnPending = false;

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

    /** @type {Set<number>} Pending GLib.idle_add source IDs to flush on disable. */
    _idleSources = new Set();

    enable() {
        this._shuttingDown = false;
        this._daemonRestartAttempts = 0;
        // Cancel any pending force-kill timer left over from a previous disable
        // (enable→disable→enable within 1.5s) so it can't outlive this cycle.
        if (this._daemonKillTimerId) {
            GLib.Source.remove(this._daemonKillTimerId);
            this._daemonKillTimerId = null;
        }

        this._settings = this.getSettings();
        this._excludedApps = this._settings.get_strv('excluded-apps');
        this._excludedAppsChangedId = this._settings.connect('changed::excluded-apps', () => {
            this._excludedApps = this._settings.get_strv('excluded-apps');
        });

        this._readSizeLimits();
        this._configChangedIds = [
            this._settings.connect('changed::max-history',  () => { this._readSizeLimits(); this._pushConfig(); }),
            this._settings.connect('changed::max-text-mb',  () => { this._readSizeLimits(); this._pushConfig(); }),
            this._settings.connect('changed::max-image-mb', () => { this._readSizeLimits(); this._pushConfig(); }),
        ];

        // Load the light theme overrides into the Shell theme context. They stay
        // inert until the panel toggles the `.strata-theme-light` class (panel.js).
        this._loadThemeStylesheet();

        this._addIndicator();
        this._spawnDaemon();
        this._connectProxy();
        this._connectFocusTracking();
        this._connectClipboardMonitor();
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
        this._clearIdleSources();
        if (this._proxyOwnerId && this._proxy) {
            this._proxy.disconnect(this._proxyOwnerId);
            this._proxyOwnerId = 0;
        }
        if (this._configChangedIds && this._settings) {
            for (const id of this._configChangedIds) this._settings.disconnect(id);
            this._configChangedIds = null;
        }
        if (this._excludedAppsChangedId && this._settings) {
            this._settings.disconnect(this._excludedAppsChangedId);
            this._excludedAppsChangedId = null;
        }
        this._panel?.destroy();
        this._panel = null;
        if (this._indicatorClickId && this._indicator) {
            this._indicator.disconnect(this._indicatorClickId);
            this._indicatorClickId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._unloadThemeStylesheet();
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
        this._indicatorClickId = this._indicator.connect('button-press-event', () => {
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

    _readClipboard() {
        if (this._clipboardTransferPending) return;
        const selection = global.display.get_selection();
        const mimes = selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
        // Password managers (KeePassXC, KeePass, some Bitwarden builds) mark
        // copied secrets with this hint mime. Honoring it lets users keep
        // their passwords out of clipboard history.
        if (mimes.includes('x-kde-passwordManagerHint')) return;
        if (this._isExcluded(this._currentFocusedApp)) return;
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
                    if (size > (mime.startsWith('image/') ? this._maxImageBytes : this._maxTextBytes)) return;
                    this._proxy?.SubmitItemRemote(mime, bytes.get_data(), () => {});
                } catch (e) {
                    logError('Clipboard read error', e);
                }
            }
        );
    }

    /** Pick the best MIME type to store from the offered list (mirrors Rust pick_mime). */
    _pickMime(mimes) {
        const PREFERRED = [
            // Raster images (size-capped at MAX_IMAGE).
            'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
            'image/bmp', 'image/tiff', 'image/x-icon',
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
        // Allowlist only: see pick_mime in the daemon. Unknown mime types are skipped.
        return null;
    }


    _spawnDaemon() {
        if (this._shuttingDown) return;
        // Coalesce overlapping spawn attempts: the async GetNameOwner check below
        // can still be in flight when the backoff timer fires _spawnDaemon again.
        // Without this guard both could call _doSpawnDaemon and spawn two daemons.
        if (this._spawnPending) return;
        this._spawnPending = true;

        // Check if a daemon is already running (e.g. via systemd user service).
        // If the D-Bus name is already owned we must not spawn a second instance.
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner',
            new GLib.Variant('(s)', [BUS_NAME]),
            null, Gio.DBusCallFlags.NONE, 2000, null,
            (_conn, result) => {
                this._spawnPending = false;
                if (this._shuttingDown) return;
                try {
                    _conn.call_finish(result);
                    // Name already owned (e.g. systemd user service) - don't spawn a second instance.
                } catch (_) {
                    this._doSpawnDaemon();
                }
            }
        );
    }

    _doSpawnDaemon() {
        if (this._shuttingDown) return;
        const daemonPath = GLib.find_program_in_path('strata-daemon');
        if (!daemonPath) {
            logError('strata-daemon not found in PATH. Install the strata-daemon package or place the binary in your PATH.');
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
            this._daemon.wait_async(null, (proc) => this._onDaemonExited(proc));
        } catch (e) {
            logError('Failed to spawn daemon', e);
            this._scheduleDaemonRestart();
        }
    }

    _notifyDaemonMissing() {
        try {
            const source = new MessageTray.Source({
                title: 'Strata',
                icon: new St.Icon({ icon_name: 'edit-paste-symbolic' }),
            });
            Main.messageTray.add(source);
            const notification = new MessageTray.Notification({
                source,
                title: 'Strata: daemon not installed',
                body: 'Install the strata-daemon package. See the project page for instructions.',
                urgency: MessageTray.Urgency.HIGH,
            });
            source.addNotification(notification);
        } catch (_) {
            // Message tray may not be available (e.g. during early startup) - already logged above.
        }
    }

    _onDaemonExited(proc) {
        // Ignore exits from anything that is not the current daemon: a stop
        // initiated by _stopDaemon (which nulls _daemon), or a stray subprocess
        // from an overlapping spawn. Otherwise we'd misattribute its exit.
        if (!this._daemon || proc !== this._daemon) return;
        const exit = proc.get_exit_status();
        const lifetimeMs = (GLib.get_monotonic_time() / 1000) - this._daemonSpawnTime;
        this._daemon = null;

        if (this._shuttingDown) return;

        // Reset attempt counter if the daemon ran long enough to be considered healthy.
        if (lifetimeMs >= 5000) {
            this._daemonRestartAttempts = 0;
        }
        this._daemonRestartAttempts++;
        logError(`daemon exited with status ${exit} after ${Math.round(lifetimeMs)}ms (restart attempt ${this._daemonRestartAttempts})`);

        if (this._daemonRestartAttempts > 5) {
            logError('Daemon crashed 5 times in rapid succession - giving up. Disable and re-enable the extension to retry.');
            return;
        }
        this._scheduleDaemonRestart();
    }

    _scheduleDaemonRestart() {
        if (this._shuttingDown) return;
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const backoffMs = 1000 * Math.pow(2, Math.max(0, this._daemonRestartAttempts - 1));
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
        // Give it 1.5s then force-terminate. Track the source so a re-enable
        // within that window can cancel it (see enable()).
        this._daemonKillTimerId = GLib.timeout_add(GLib.PRIORITY_LOW, 1500, () => {
            this._daemonKillTimerId = null;
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
                    if (this._shuttingDown || proxy !== this._proxy) return;
                    if (error) {
                        logError('D-Bus proxy error', error);
                        return;
                    }
                    this._connectSignals();
                    this._panel = new StrataPanel(proxy, this._settings);
                    // Push config now if the daemon is already up, and
                    // again on every owner transition so a respawned
                    // daemon picks up the latest values.
                    this._pushConfig();
                    this._proxyOwnerId = proxy.connect('notify::g-name-owner',
                        () => { if (proxy.g_name_owner) this._pushConfig(); });
                }
            );
        } catch (e) {
            logError('Failed to create D-Bus proxy', e);
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
        this._itemAddedId = this._proxy.connectSignal('ItemAdded',
            (_p, _sender, [id, mimeType, preview]) =>
                this._onItemAdded(id, mimeType, preview));

        this._itemDeletedId = this._proxy.connectSignal('ItemDeleted',
            (_p, _sender, [id]) => {
                try {
                    const cachePath =
                        `${GLib.get_user_cache_dir()}/strata/thumbnails/${id}.png`;
                    GLib.unlink(cachePath);
                } catch (_) {}
                this._addIdleSource(() => this._panel?.removeItem(id));
            });

        this._historyClearedId = this._proxy.connectSignal('HistoryCleared',
            () => {
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
                } catch (e) { logError('cache clear failed', e); }
                this._addIdleSource(() => this._panel?.clearItems());
            });
    }

    _disconnectSignals() {
        if (this._itemAddedId && this._proxy) {
            this._proxy.disconnectSignal(this._itemAddedId);
            this._itemAddedId = null;
        }
        if (this._itemDeletedId && this._proxy) {
            this._proxy.disconnectSignal(this._itemDeletedId);
            this._itemDeletedId = null;
        }
        if (this._historyClearedId && this._proxy) {
            this._proxy.disconnectSignal(this._historyClearedId);
            this._historyClearedId = null;
        }
        if (this._pendingSignalId !== null) {
            GLib.Source.remove(this._pendingSignalId);
            this._pendingSignalId = null;
        }
    }


    /** Schedule a one-shot idle callback whose source ID is tracked so disable()
     *  can drop pending work instead of leaking a closure on `this`. */
    _addIdleSource(callback) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleSources.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._idleSources.add(id);
        return id;
    }

    _clearIdleSources() {
        for (const id of this._idleSources) GLib.Source.remove(id);
        this._idleSources.clear();
    }

    _onItemAdded(id, mimeType, preview) {
        // Debounce: if the daemon emits a burst, coalesce into one update.
        if (this._pendingSignalId !== null) {
            GLib.Source.remove(this._pendingSignalId);
            this._pendingSignalId = null;
        }
        this._pendingSignalId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._pendingSignalId = null;
            this._addIdleSource(() => this._panel?.prependItem(id, mimeType, preview));
            return GLib.SOURCE_REMOVE;
        });
    }

    _isExcluded(appClass) {
        if (!appClass) return false;
        return this._excludedApps.some(ex => appClass.includes(ex.toLowerCase()));
    }


    _connectFocusTracking() {
        this._focusSignalId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            this._currentFocusedApp = (win?.get_wm_class() ?? '').toLowerCase();
        });
    }

    _disconnectFocusTracking() {
        if (this._focusSignalId !== null) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = null;
        }
    }


    _registerShortcut() {
        // POPUP is included so the shortcut still fires while the panel's own
        // modal grab is active (pushModal sets actionMode POPUP). Without it the
        // second press is swallowed by the grab and toggle() never runs, so the
        // panel could open but not close via the shortcut.
        Main.wm.addKeybinding(
            'keyboard-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._panel?.toggle()
        );
    }

    _unregisterShortcut() {
        Main.wm.removeKeybinding('keyboard-shortcut');
    }


    /** Load light.css once. It is scoped under `.strata-theme-light` and stays
     *  inert until the panel adds that class. We do not subscribe to the theme
     *  context's 'changed' signal because load_stylesheet itself emits it. */
    _loadThemeStylesheet() {
        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            this._lightCssFile = this.dir.get_child('light.css');
            this._stTheme = themeContext.get_theme();
            this._stTheme.load_stylesheet(this._lightCssFile);
        } catch (e) {
            logError('Failed to load light.css', e);
        }
    }

    _unloadThemeStylesheet() {
        try {
            this._stTheme?.unload_stylesheet(this._lightCssFile);
        } catch (e) {
            logError('Failed to unload light.css', e);
        }
        this._stTheme = null;
        this._lightCssFile = null;
    }
}
