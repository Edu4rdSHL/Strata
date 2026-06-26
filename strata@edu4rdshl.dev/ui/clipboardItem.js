/* clipboardItem.js - row widget for the clipboard list. */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

const TEXT_PREVIEW_LEN = 140;
const THUMB_SIZE = 48;

const ICON_BY_MIME = {
    'text/uri-list': 'emblem-web-symbolic',
    'text/html':     'text-html-symbolic',
    'image/':        'image-x-generic-symbolic',
};

function iconForMime(mimeType) {
    for (const [prefix, icon] of Object.entries(ICON_BY_MIME)) {
        if (mimeType.startsWith(prefix)) return icon;
    }
    return 'edit-copy-symbolic';
}

function isUrl(text) {
    return /^https?:\/\/.+/i.test(text.trim());
}

function isColor(text) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text.trim());
}

export const ClipboardItem = GObject.registerClass({
    GTypeName: 'StrataClipboardItem',
    Signals: {
        'activate': {},
        'delete':   {},
    },
}, class extends St.Button {
    constructor(id, mimeType, preview, opts = {}) {
        super({
            style_class: 'strata-item',
            x_expand: true,
            can_focus: true,
            reactive: true,
        });

        this._id = id;
        this._mimeType = mimeType;
        this._proxy = opts.proxy ?? null;
        this._thumbCache = opts.thumbCache ?? null;

        const row = new St.BoxLayout({
            style_class: 'strata-item-row',
            x_expand: true,
        });

        row.add_child(this._buildLeading(mimeType, preview));
        row.add_child(this._buildContent(mimeType, preview));

        const deleteBtn = new St.Button({
            style_class: 'strata-item-delete',
            icon_name: 'edit-delete-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        deleteBtn.connect('clicked', () => {
            this.emit('delete');
            return Clutter.EVENT_STOP;
        });
        row.add_child(deleteBtn);

        this.set_child(row);
        this.connect('clicked', () => this.emit('activate'));

        // Make the item text bold when keyboard-focused so the selected item
        // is immediately obvious during arrow-key navigation.
        // We add/remove an explicit style class because CSS :focus pseudo-class
        // can be unreliable in GNOME Shell extensions. The bold + focus text
        // color live in CSS (.strata-item-focused .strata-item-text) so each
        // theme (dark/light) can color them; we only toggle the class here.
        this.connect('key-focus-in', () => {
            this.add_style_class_name('strata-item-focused');
        });
        this.connect('key-focus-out', () => {
            this.remove_style_class_name('strata-item-focused');
        });
    }

    _buildLeading(mimeType, preview) {
        if (mimeType.startsWith('image/')) {
            return this._buildThumbnail(this._id);
        }
        if (isColor(preview)) {
            return this._buildColorSwatch(preview);
        }
        const icon = new St.Icon({
            icon_name: iconForMime(mimeType),
            icon_size: 20,
            style_class: 'strata-item-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        return icon;
    }

    _buildThumbnail(id) {
        const container = new St.Widget({
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            style_class: 'strata-item-thumb',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const cacheDir = `${GLib.get_user_cache_dir()}/strata/thumbnails`;
        const cachePath = `${cacheDir}/${id}.png`;
        const fileUri = `file://${cachePath}`;

        const applyStyle = () => {
            try {
                container.style = `background-image: url("${fileUri}"); background-size: cover; background-repeat: no-repeat;`;
            } catch { /* container was destroyed mid-flight */ }
        };

        try {
            if (this._thumbCache?.has(id)) {
                applyStyle();
                return container;
            }
            if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
                this._thumbCache?.set(id, cachePath);
                applyStyle();
                return container;
            }
            GLib.mkdir_with_parents(cacheDir, 0o755);
            if (!this._proxy) {
                this._fallbackIcon(container);
                return container;
            }
            this._proxy.GetThumbnailRemote(id, ([bytes]) => {
                try {
                    if (!container.get_parent()) return; // destroyed
                    if (!bytes || bytes.length === 0) {
                        this._fallbackIcon(container);
                        return;
                    }
                    const file = Gio.File.new_for_path(cachePath);
                    file.replace_contents_bytes_async(
                        new GLib.Bytes(bytes),
                        null,
                        false,
                        Gio.FileCreateFlags.NONE,
                        null,
                        (_f, result) => {
                            try {
                                _f.replace_contents_finish(result);
                                this._thumbCache?.set(id, cachePath);
                                applyStyle();
                            } catch (e) {
                                console.error('[Strata] Thumbnail write error:', e);
                                this._fallbackIcon(container);
                            }
                        }
                    );
                } catch (e) {
                    console.error('[Strata] Thumbnail fetch handler error:', e);
                    this._fallbackIcon(container);
                }
            });
        } catch (e) {
            console.error('[Strata] Thumbnail render error:', e);
            this._fallbackIcon(container);
        }
        return container;
    }

    _fallbackIcon(container) {
        if (container.get_n_children() > 0) return;
        try {
            const icon = new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                icon_size: 20,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            container.add_child(icon);
        } catch { /* container destroyed before the icon was added */ }
    }

    _buildColorSwatch(hex) {
        return new St.Widget({
            width: 24,
            height: 24,
            style: `background-color: ${hex}; border-radius: 4px; border: 1px solid rgba(0,0,0,0.2);`,
            style_class: 'strata-item-swatch',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _buildContent(mimeType, preview) {
        preview = preview ?? '';
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'strata-item-content',
        });

        let mainText;
        let subText = '';

        if (mimeType.startsWith('image/')) {
            // Generic label - the thumbnail identifies the image, and the
            // on-clipboard format (often PNG even for a copied GIF/WebP) is an
            // implementation detail that misleads more than it informs.
            mainText = 'Image';
        } else if (isUrl(preview)) {
            mainText = preview.trim();
            try {
                subText = GLib.Uri.parse(preview.trim(), GLib.UriFlags.NONE).get_host() ?? '';
            } catch { /* not a parseable URI */ }
        } else if (isColor(preview)) {
            mainText = preview.trim().toUpperCase();
            subText  = 'Color';
        } else {
            const trimmed = preview.replace(/\s+/g, ' ').trim();
            mainText = trimmed.length > TEXT_PREVIEW_LEN
                ? trimmed.slice(0, TEXT_PREVIEW_LEN) + '…'
                : trimmed;
        }

        const labelMain = new St.Label({
            text: mainText || '(empty)',
            style_class: `strata-item-text${isUrl(preview) ? ' strata-item-url' : ''}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        labelMain.clutter_text.line_wrap = false;
        labelMain.clutter_text.ellipsize = 3; // PANGO_ELLIPSIZE_END
        box.add_child(labelMain);

        if (subText) {
            const labelSub = new St.Label({
                text: subText,
                style_class: 'strata-item-subtext',
                x_expand: true,
            });
            box.add_child(labelSub);
        }

        return box;
    }
});
