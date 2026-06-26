/* util.js - shared helpers for the Strata extension. */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function logError(label, err) {
    if (err instanceof GLib.Error)
        Gio.DBusError.strip_remote_error(err);
    const tail = err !== undefined ? `: ${err?.message ?? err}` : '';
    console.error(`[Strata] ${label}${tail}`);
}
