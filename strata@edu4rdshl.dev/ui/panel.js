/* panel.js - Strata clipboard popup panel. */

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ClipboardItem } from './clipboardItem.js';

const SEARCH_LIMIT = 500;
const SEARCH_DEBOUNCE_MS = 150;
const LOAD_MORE_THRESHOLD = 200;

export class StrataPanel {
    constructor(proxy, settings, indicator = null) {
        this._proxy = proxy;
        this._settings = settings;
        this._indicator = indicator; // PanelMenu.Button - used to avoid toggle-reopen race
        this._pageSize = settings.get_int('page-size');
        this._pageSizeChangedId = settings.connect('changed::page-size',
            () => { this._pageSize = settings.get_int('page-size'); });
        /** @type {{ id: string, mimeType: string, preview: string }[]} */
        this._items = [];
        /** @type {Map<string, ClipboardItem>} id → widget */
        this._widgets = new Map();
        /** @type {Map<string, string>} id → cache file path (shared across widget lifetimes) */
        this._thumbCache = new Map();
        /** Pagination state for the non-search view. */
        this._loadedOffset = 0;          // how many items we've already pulled
        this._hasMore = true;            // false once daemon returns < PAGE_SIZE
        this._loadingMore = false;       // re-entrancy guard for scroll-driven loads
        /** Search state. */
        this._searchQuery = '';          // current search string ('' = no search)
        this._searchDebounceId = null;   // pending GLib timeout for debounce
        this._searchEpoch = 0;           // monotonic counter to discard stale search responses

        this._visible = false;
        this._grab = null;        // Clutter.Grab from Main.pushModal
        this._hoveredWidget = null; // currently mouse-hovered ClipboardItem
        this._activeWidget = null;  // most recently copied item

        this._buildUI();
        // Trigger the initial load as soon as the daemon owns its bus name.
        // At extension boot the daemon may still be starting (its D-Bus name
        // not yet owned); the proxy fires notify::g-name-owner when that
        // changes, so we listen for the first transition to a non-null owner
        // and only then issue GetHistory. If the daemon is already up, the
        // owner is already set and we load immediately.
        this._tryInitialLoad();
        this._nameOwnerId = this._proxy.connect('notify::g-name-owner',
            () => this._tryInitialLoad());
    }

    _tryInitialLoad() {
        if (this._initialLoaded) return;
        if (!this._proxy.g_name_owner) return;
        this._initialLoaded = true;
        this._loadHistory(0, this._pageSize).catch(e =>
            console.error('[Strata] initial _loadHistory failed:', e));
    }


    _buildUI() {
        // Overlay container - sits above all windows.
        this._overlay = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            visible: false,
            reactive: true,
        });
        Main.layoutManager.addChrome(this._overlay);

        // Close when clicking outside the panel box.
        // With pushModal active, ALL pointer events are delivered to _overlay,
        // so this handler sees every click on screen.
        this._overlay.connect('button-press-event', (_actor, event) => {
            const [cx, cy] = event.get_coords();
            const [bx, by] = this._box.get_transformed_position();
            const [bw, bh] = this._box.get_transformed_size();
            if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });

        // pushModal intercepts all motion events at the overlay level, so CSS
        // :hover never fires on child actors. Manually track which item is
        // under the cursor and toggle the JS-driven 'strata-item-hovered' class.
        this._overlay.connect('motion-event', (_actor, event) => {
            const [cx, cy] = event.get_coords();
            let found = null;
            for (const widget of this._widgets.values()) {
                if (!widget.visible) continue;
                const [wx, wy] = widget.get_transformed_position();
                const [ww, wh] = widget.get_transformed_size();
                if (cx >= wx && cx <= wx + ww && cy >= wy && cy <= wy + wh) {
                    found = widget;
                    break;
                }
            }
            if (found !== this._hoveredWidget) {
                this._hoveredWidget?.remove_style_class_name('strata-item-hovered');
                this._hoveredWidget = found;
                found?.add_style_class_name('strata-item-hovered');
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._overlay.connect('leave-event', () => {
            this._hoveredWidget?.remove_style_class_name('strata-item-hovered');
            this._hoveredWidget = null;
            return Clutter.EVENT_PROPAGATE;
        });

        // Panel box
        this._box = new St.BoxLayout({
            style_class: 'strata-panel',
            vertical: true,
            reactive: true,
        });

        // Header row: title + clear button
        const header = new St.BoxLayout({
            style_class: 'strata-header',
            x_expand: true,
        });
        const title = new St.Label({
            text: 'Clipboard',
            style_class: 'strata-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const clearBtn = new St.Button({
            label: 'Clear all',
            style_class: 'strata-clear-btn',
            y_align: Clutter.ActorAlign.CENTER,
        });
        clearBtn.connect('clicked', () => this._clearAll());
        header.add_child(title);
        header.add_child(clearBtn);

        // Search box
        this._searchEntry = new St.Entry({
            hint_text: 'Search…',
            style_class: 'strata-search',
            x_expand: true,
            can_focus: true,
        });
        this._searchEntry.get_clutter_text().connect('text-changed', () => {
            this._scheduleSearch(this._searchEntry.get_text());
        });
        // Down arrow from search box moves focus to the first item.
        this._searchEntry.get_clutter_text().connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Down) {
                this._focusItem(0);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Item list
        this._scrollView = new St.ScrollView({
            style_class: 'strata-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
        });
        this._itemList = new St.BoxLayout({
            style_class: 'strata-item-list',
            vertical: true,
            x_expand: true,
        });
        this._scrollView.set_child(this._itemList);

        // Load more items when scrolled near the bottom.
        const vadj = this._scrollView.get_vadjustment();
        if (vadj) {
            vadj.connect('notify::value', () => this._maybeLoadMore());
            // Also re-check when the list grows (a new page just appended).
            vadj.connect('notify::upper', () => this._maybeLoadMore());
        }

        // Assemble
        this._box.add_child(header);
        this._box.add_child(this._searchEntry);
        this._box.add_child(this._scrollView);
        this._overlay.add_child(this._box);

        // ESC to close
        this._overlay.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }


    toggle() {
        this._visible ? this.close() : this.open();
    }

    open() {
        if (this._visible) return;
        this._visible = true;
        this._overlay.show();
        this._positionPanel();
        // Re-position after one frame so bottom/center use the fully allocated height.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._visible) this._positionPanel();
            return GLib.SOURCE_REMOVE;
        });

        // pushModal grabs ALL input and delivers it to _overlay - this is the
        // proper GNOME Shell pattern for "click outside to close" dialogs.
        this._grab = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._searchEntry.set_text('');
        // Reset to non-search view - but DON'T reload; history may already be populated.
        this._searchQuery = '';
        // If the initial history load failed (e.g. daemon wasn't ready at startup),
        // retry now that the user is asking to see the list.
        if (this._items.length === 0 && this._loadedOffset === 0 && this._hasMore) {
            this._loadHistory(0, this._pageSize).catch(e =>
                console.error('[Strata] open: history reload failed:', e));
        }
        global.stage.set_key_focus(this._searchEntry.get_clutter_text());
    }

    close() {
        if (!this._visible) return;
        this._visible = false;
        // Clear hover state since the panel is closing.
        this._hoveredWidget?.remove_style_class_name('strata-item-hovered');
        this._hoveredWidget = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._overlay.hide();
    }

    /** Prepend a newly added item. Wrapped in try/catch so one bad item can't
     *  break subsequent additions. */
    prependItem(id, mimeType, preview) {
        try {
            this._items.unshift({ id, mimeType, preview });
            this._loadedOffset += 1;

            if (this._widgets.has(id)) {
                this._widgets.get(id)?.destroy();
                this._widgets.delete(id);
            }

            // While searching, only render if the new item matches the active query.
            if (this._searchQuery && !this._matchesSearch(preview, mimeType)) {
                return;
            }

            const widget = this._makeItemWidget(id, mimeType, preview);
            this._widgets.set(id, widget);
            this._itemList.insert_child_at_index(widget.actor, 0);
            this._setActiveWidget(widget);
        } catch (e) {
            console.error(`[Strata] prependItem failed for id=${id} mime=${mimeType}:`, e);
            this._items = this._items.filter(i => i.id !== id);
        }
    }

    // Substring match used for newly-arrived items while a search is active.
    // Approximates FTS5 prefix match until the next debounced search refresh.
    _matchesSearch(preview, mimeType) {
        if (mimeType?.startsWith('image/')) return false;
        if (!preview) return false;
        const haystack = preview.toLowerCase();
        return this._searchQuery.toLowerCase().split(/\s+/)
            .filter(Boolean).every(tok => haystack.includes(tok));
    }

    removeItem(id) {
        this._items = this._items.filter(i => i.id !== id);
        const widget = this._widgets.get(id);
        if (widget) {
            const wasActive  = widget === this._activeWidget;
            const wasHovered = widget === this._hoveredWidget;
            if (wasActive)  this._activeWidget  = null;
            if (wasHovered) this._hoveredWidget = null;
            widget.destroy();
            this._widgets.delete(id);
            // Re-assign active to the new first visible item.
            if (wasActive) {
                const first = this._getVisibleItems()[0];
                if (first) this._setActiveWidget(first);
            }
        }
    }

    clearItems() {
        this._items = [];
        this._hoveredWidget = null;
        this._activeWidget  = null;
        this._widgets.forEach(w => w.destroy());
        this._widgets.clear();
        this._itemList.destroy_all_children();
    }

    destroy() {
        if (this._pageSizeChangedId) {
            this._settings.disconnect(this._pageSizeChangedId);
            this._pageSizeChangedId = 0;
        }
        if (this._nameOwnerId) {
            this._proxy.disconnect(this._nameOwnerId);
            this._nameOwnerId = 0;
        }
        if (this._initialLoadId) {
            GLib.Source.remove(this._initialLoadId);
            this._initialLoadId = null;
        }
        if (this._searchDebounceId) {
            GLib.Source.remove(this._searchDebounceId);
            this._searchDebounceId = null;
        }
        this.close();
        this.clearItems();
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = null;
    }


    async _loadHistory(offset, limit) {
        if (!this._overlay) return 0;
        try {
            const [json] = await this._proxy.GetHistoryAsync(offset, limit);
            if (!this._overlay) return 0;
            const items = JSON.parse(json);
            const BATCH = 20;
            for (let i = 0; i < items.length; i += BATCH) {
                if (!this._overlay) return items.length;
                await new Promise(resolve =>
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        const end = Math.min(i + BATCH, items.length);
                        for (let j = i; j < end; j++) this._appendItemFromMeta(items[j]);
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    })
                );
            }
            this._loadedOffset = offset + items.length;
            this._hasMore = items.length >= limit;
            if (offset === 0 && items.length > 0) {
                const firstWidget = this._widgets.get(items[0].id);
                if (firstWidget) this._setActiveWidget(firstWidget);
            }
            return items.length;
        } catch (e) {
            console.error('[Strata] _loadHistory failed:', e);
            return 0;
        }
    }

    _appendItemFromMeta(meta) {
        try {
            const id = meta.id;
            const mimeType = meta.mime_type;
            const preview = meta.content_text ?? '';
            if (this._widgets.has(id)) return;

            this._items.push({ id, mimeType, preview });
            const widget = this._makeItemWidget(id, mimeType, preview);
            this._widgets.set(id, widget);
            this._itemList.add_child(widget.actor);
        } catch (e) {
            console.error(`[Strata] _appendItemFromMeta failed for id=${meta?.id}:`, e);
        }
    }

    _maybeLoadMore() {
        if (this._searchQuery) return;
        if (!this._hasMore || this._loadingMore) return;
        const adj = this._scrollView.get_vadjustment();
        if (!adj || adj.upper <= adj.page_size) return;
        const distanceToBottom = adj.upper - (adj.value + adj.page_size);
        if (distanceToBottom > LOAD_MORE_THRESHOLD) return;

        this._loadingMore = true;
        this._loadHistory(this._loadedOffset, this._pageSize)
            .finally(() => { this._loadingMore = false; });
    }


    _makeItemWidget(id, mimeType, preview) {
        const widget = new ClipboardItem(id, mimeType, preview, {
            proxy: this._proxy,
            thumbCache: this._thumbCache,
        });
        widget.connect('activate', () => {
            this._setActiveWidget(widget);
            if (this._settings?.get_boolean('move-activated-to-top'))
                this._moveItemToTop(id, widget);
            this._onItemActivated(id);
        });
        widget.connect('delete', () => {
            this._proxy.DeleteItemRemote(id, () => {});
        });
        widget.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            const items = this._getVisibleItems();
            const idx = items.indexOf(widget);
            if (sym === Clutter.KEY_Down) {
                if (idx < items.length - 1) {
                    global.stage.set_key_focus(items[idx + 1]);
                    this._ensureVisible(items[idx + 1]);
                }
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Up) {
                if (idx <= 0) {
                    global.stage.set_key_focus(this._searchEntry.get_clutter_text());
                } else {
                    global.stage.set_key_focus(items[idx - 1]);
                    this._ensureVisible(items[idx - 1]);
                }
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return widget;
    }

    /** Focus the item at visible-list index `idx` (clamped). */
    _focusItem(idx) {
        const items = this._getVisibleItems();
        if (items.length === 0) return;
        global.stage.set_key_focus(items[Math.max(0, Math.min(idx, items.length - 1))]);
    }

    /** All currently-visible item actors in order. */
    _getVisibleItems() {
        return this._itemList.get_children().filter(c => c.visible);
    }

    _ensureVisible(widget) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                const adj = this._scrollView.get_vadjustment();
                if (!adj || adj.page_size === 0) return GLib.SOURCE_REMOVE;

                // Allocation box coords share the same space as adj.value.
                const box = widget.get_allocation_box();
                const cur = adj.value;
                const pageSize = adj.page_size;

                if (box.y1 < cur)
                    adj.value = box.y1;
                else if (box.y2 > cur + pageSize)
                    adj.value = box.y2 - pageSize;
            } catch (e) {
                console.error('[Strata] ensureVisible error:', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    async _onItemActivated(id) {
        try {
            const [mimeType, contentB64] = await this._proxy.GetItemContentAsync(id);
            this._writeToClipboard(mimeType, GLib.base64_decode(contentB64));
        } catch (e) {
            console.error('[Strata] Paste error:', e);
        }
        this.close();
    }

    _writeToClipboard(mimeType, bytes) {
        try {
            if (mimeType.startsWith('text/') || mimeType === 'UTF8_STRING') {
                const text = new TextDecoder('utf-8').decode(bytes);
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            } else {
                const source = Meta.SelectionSourceMemory.new(
                    mimeType,
                    GLib.Bytes.new(bytes)
                );
                global.display.get_selection().set_owner(
                    Meta.SelectionType.SELECTION_CLIPBOARD,
                    source
                );
            }
        } catch (e) {
            console.error('[Strata] Clipboard write error:', e);
        }
    }

    async _clearAll() {
        try {
            await this._proxy.ClearHistoryAsync();
        } catch (e) {
            console.error('[Strata] ClearHistory error:', e);
        }
    }

    /** Debounce search box keystrokes; collapse rapid edits into one query. */
    _scheduleSearch(query) {
        if (this._searchDebounceId) {
            GLib.Source.remove(this._searchDebounceId);
            this._searchDebounceId = null;
        }
        const trimmed = (query ?? '').trim();
        this._searchDebounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                this._searchDebounceId = null;
                this._runSearch(trimmed).catch(e =>
                    console.error('[Strata] search failed:', e));
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Apply a search query (empty = reset to the recent-history view).
     *  All state-mutating writes are guarded with an epoch so a fast-cancelled
     *  search cannot overwrite the results of a newer one. */
    async _runSearch(query) {
        const epoch = ++this._searchEpoch;
        if (!query) {
            this._searchQuery = '';
            this._clearListDom();
            this._items = [];
            this._loadedOffset = 0;
            this._hasMore = true;
            // Don't await: if the user starts a new search mid-load, the epoch
            // guard inside _appendItemFromMeta's caller would still let stale
            // rows leak in. So check the epoch before letting any rows in.
            const ePromise = this._loadHistory(0, this._pageSize);
            ePromise.then(() => {
                if (epoch !== this._searchEpoch) {
                    // A newer search superseded us; nuke whatever we appended.
                    this._clearListDom();
                    this._items = [];
                }
            }).catch(e => console.error('[Strata] reset-history failed:', e));
            return;
        }

        this._searchQuery = query;
        let json;
        try {
            [json] = await this._proxy.SearchHistoryAsync(query, SEARCH_LIMIT);
        } catch (e) {
            console.error('[Strata] SearchHistory D-Bus error:', e);
            return;
        }
        if (epoch !== this._searchEpoch || !this._overlay) return; // stale or destroyed

        let results;
        try {
            results = JSON.parse(json);
        } catch (e) {
            console.error('[Strata] SearchHistory: bad JSON:', e);
            return;
        }

        this._clearListDom();
        this._items = [];
        // Disable pagination while searching - the search response is already
        // bounded by SEARCH_LIMIT, scrolling shouldn't pull more.
        this._hasMore = false;
        this._loadedOffset = 0;

        const BATCH = 20;
        for (let i = 0; i < results.length; i += BATCH) {
            if (epoch !== this._searchEpoch || !this._overlay) return;
            await new Promise(resolve =>
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    const end = Math.min(i + BATCH, results.length);
                    for (let j = i; j < end; j++) this._appendItemFromMeta(results[j]);
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
        }
    }

    /** Tear down all rendered item widgets (without touching the data model). */
    _clearListDom() {
        this._hoveredWidget = null;
        this._activeWidget = null;
        this._widgets.forEach(w => w.destroy());
        this._widgets.clear();
        this._itemList.destroy_all_children();
    }

    _setActiveWidget(widget) {
        this._activeWidget?.remove_style_class_name('strata-item-active');
        this._activeWidget = widget ?? null;
        widget?.add_style_class_name('strata-item-active');
    }

    _moveItemToTop(id, widget) {
        // Move data model entry to front.
        const idx = this._items.findIndex(i => i.id === id);
        if (idx > 0) {
            const [entry] = this._items.splice(idx, 1);
            this._items.unshift(entry);
        }
        // Move actor to position 0 in the list.
        this._itemList.set_child_at_index(widget, 0);
    }

    _positionPanel() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const PANEL_W = Math.min(
            this._settings?.get_int('panel-width') ?? 480,
            monitor.width * 0.9
        );
        const MAX_H = Math.min(
            this._settings?.get_int('panel-max-height') ?? 600,
            monitor.height * 0.85
        );

        this._box.set_width(PANEL_W);
        // Let height shrink to content; cap at MAX_H so the scroll view kicks in
        // when there are many items.
        this._box.set_height(-1);
        this._box.style = `max-height: ${MAX_H}px;`;

        const position = this._settings?.get_string('panel-position') ?? 'top-center';
        const MARGIN = 16; // px gap from screen edge

        let x, y;
        // Horizontal
        if (position.endsWith('left'))
            x = monitor.x + MARGIN;
        else if (position.endsWith('right'))
            x = monitor.x + monitor.width - PANEL_W - MARGIN;
        else // center
            x = monitor.x + Math.round((monitor.width - PANEL_W) / 2);

        // Vertical - snap to shell bars so the panel feels native
        const topBarH = Main.layoutManager.panelBox?.height ?? 32;
        if (position.startsWith('top')) {
            y = monitor.y + topBarH + MARGIN;
        } else {
            // For bottom/center we need the actual rendered height, not MAX_H.
            // get_preferred_height(-1) returns [minH, naturalH] synchronously.
            const [, naturalH] = this._box.get_preferred_height(-1);
            const actualH = Math.min(naturalH, MAX_H);
            if (position.startsWith('bottom'))
                y = monitor.y + monitor.height - actualH - MARGIN;
            else // center
                y = monitor.y + Math.round((monitor.height - actualH) / 2);
        }

        this._box.set_position(Math.round(x), Math.round(y));

        // Overlay fills the screen for click-outside detection.
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
    }
}
