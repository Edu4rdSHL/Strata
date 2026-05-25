/**
 * prefs.js - Strata preferences window (GNOME 45+ / Adw).
 *
 * Pages:
 *  General:  max-history SpinRow, keyboard-shortcut ShortcutRow
 *  Privacy:  excluded-apps ExpanderRow + StringList (one entry per line)
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class StrataPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buildGeneralPage(settings));
        window.add(this._buildPrivacyPage(settings));
    }

    // -------------------------------------------------------------------------
    // General page
    // -------------------------------------------------------------------------

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        // ── History ──────────────────────────────────────────────────────────
        const historyGroup = new Adw.PreferencesGroup({ title: 'History' });

        const maxHistoryRow = new Adw.SpinRow({
            title: 'Maximum items',
            subtitle: 'All items are searchable and reachable; older are deleted past this limit',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 2000,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('max-history', maxHistoryRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(maxHistoryRow);

        const pageSizeRow = new Adw.SpinRow({
            title: 'Items per page',
            subtitle: 'Rows fetched on open and on each scroll-to-bottom',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 200,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('page-size', pageSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(pageSizeRow);

        const maxTextRow = new Adw.SpinRow({
            title: 'Maximum text size (MB)',
            subtitle: 'Text payloads larger than this are not stored',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('max-text-mb', maxTextRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(maxTextRow);

        const maxImageRow = new Adw.SpinRow({
            title: 'Maximum image size (MB)',
            subtitle: 'Image payloads larger than this are not stored',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('max-image-mb', maxImageRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(maxImageRow);

        page.add(historyGroup);

        // ── Appearance ───────────────────────────────────────────────────────
        const appearanceGroup = new Adw.PreferencesGroup({ title: 'Appearance' });

        const panelWidthRow = new Adw.SpinRow({
            title: 'Panel width',
            subtitle: 'Width of the clipboard panel in pixels',
            adjustment: new Gtk.Adjustment({
                lower: 200,
                upper: 1200,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('panel-width', panelWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(panelWidthRow);

        const panelMaxHeightRow = new Adw.SpinRow({
            title: 'Panel max height',
            subtitle: 'Maximum height before the list scrolls',
            adjustment: new Gtk.Adjustment({
                lower: 200,
                upper: 1200,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('panel-max-height', panelMaxHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(panelMaxHeightRow);

        const moveToTopRow = new Adw.SwitchRow({
            title: 'Move activated item to top',
            subtitle: 'Selecting an item moves it to the top of the list',
        });
        settings.bind('move-activated-to-top', moveToTopRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(moveToTopRow);

        const positions = [
            { id: 'top-center',    label: 'Top center'    },
            { id: 'top-left',      label: 'Top left'      },
            { id: 'top-right',     label: 'Top right'     },
            { id: 'center',        label: 'Center'        },
            { id: 'bottom-center', label: 'Bottom center' },
            { id: 'bottom-left',   label: 'Bottom left'   },
            { id: 'bottom-right',  label: 'Bottom right'  },
        ];

        const positionRow = new Adw.ComboRow({
            title: 'Panel position',
            subtitle: 'Where the clipboard panel appears on screen',
            model: Gtk.StringList.new(positions.map(p => p.label)),
        });

        const currentPos = settings.get_string('panel-position');
        const currentIdx = positions.findIndex(p => p.id === currentPos);
        positionRow.selected = currentIdx >= 0 ? currentIdx : 0;

        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positions[positionRow.selected].id);
        });
        settings.connect('changed::panel-position', () => {
            const idx = positions.findIndex(p => p.id === settings.get_string('panel-position'));
            if (idx >= 0 && positionRow.selected !== idx)
                positionRow.selected = idx;
        });
        appearanceGroup.add(positionRow);

        page.add(appearanceGroup);

        // ── Keyboard ─────────────────────────────────────────────────────────
        const kbGroup = new Adw.PreferencesGroup({ title: 'Keyboard' });

        const shortcutRow = new Adw.ActionRow({
            title: 'Open Strata',
            subtitle: 'Click to change the keyboard shortcut',
            activatable: true,
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
        });
        const updateShortcutLabel = () => {
            const shortcuts = settings.get_strv('keyboard-shortcut');
            shortcutLabel.accelerator = shortcuts[0] ?? '';
        };
        updateShortcutLabel();
        settings.connect('changed::keyboard-shortcut', updateShortcutLabel);
        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.connect('activated', () => {
            this._showShortcutDialog(shortcutRow.get_root(), settings);
        });
        kbGroup.add(shortcutRow);
        page.add(kbGroup);

        return page;
    }

    // -------------------------------------------------------------------------
    // Privacy page
    // -------------------------------------------------------------------------

    _buildPrivacyPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Privacy',
            icon_name: 'security-high-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'App Exclusions',
            description: 'Items copied while these apps have focus will not be stored in history. Enter a partial app name (case-insensitive).',
        });

        // We use a StringList model bound to excluded-apps.
        const model = new Gtk.StringList();
        const currentApps = settings.get_strv('excluded-apps');
        for (const app of currentApps)
            model.append(app);

        /** Sync the StringList back to GSettings. */
        const saveModel = () => {
            const apps = [];
            for (let i = 0; i < model.get_n_items(); i++) {
                const val = model.get_string(i);
                if (val?.trim()) apps.push(val.trim());
            }
            settings.set_strv('excluded-apps', apps);
        };

        // Each item in the list: an EditableLabel + Remove button.
        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        const rebuildList = () => {
            let child = listBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                listBox.remove(child);
                child = next;
            }
            for (let i = 0; i < model.get_n_items(); i++) {
                const idx = i;
                const row = new Adw.ActionRow({ activatable: false });
                const label = new Gtk.EditableLabel({
                    text: model.get_string(i),
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                });
                label.connect('changed', () => {
                    model.splice(idx, 1, [label.text]);
                    saveModel();
                });
                const removeBtn = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'destructive-action'],
                    tooltip_text: 'Remove',
                });
                removeBtn.connect('clicked', () => {
                    model.remove(idx);
                    saveModel();
                    rebuildList();
                });
                row.add_suffix(label);
                row.add_suffix(removeBtn);
                listBox.append(row);
            }

            // Add-new row.
            const addRow = new Adw.ActionRow({ activatable: false });
            const addEntry = new Gtk.Entry({
                placeholder_text: 'App name…',
                valign: Gtk.Align.CENTER,
                hexpand: true,
            });
            const addBtn = new Gtk.Button({
                icon_name: 'list-add-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Add',
            });
            const doAdd = () => {
                const val = addEntry.text.trim();
                if (val) {
                    model.append(val);
                    saveModel();
                    rebuildList();
                }
            };
            addBtn.connect('clicked', doAdd);
            addEntry.connect('activate', doAdd);
            addRow.add_suffix(addEntry);
            addRow.add_suffix(addBtn);
            listBox.append(addRow);
        };

        rebuildList();
        group.add(listBox);
        page.add(group);
        return page;
    }

    // -------------------------------------------------------------------------
    // Keyboard shortcut dialog
    // -------------------------------------------------------------------------

    _showShortcutDialog(parent, settings) {
        const dialog = new Adw.MessageDialog({
            heading: 'Set Keyboard Shortcut',
            body: 'Press the desired key combination, or Backspace to clear.',
            transient_for: parent,
            modal: true,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear',  'Clear');

        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv('keyboard-shortcut')[0] ?? '',
            disabled_text: '(none)',
            margin_top: 12,
            margin_bottom: 12,
            halign: Gtk.Align.CENTER,
        });
        dialog.set_extra_child(label);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_ctrl, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_BackSpace) {
                label.accelerator = '';
                return true;
            }
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            if (Gtk.accelerator_valid(keyval, mods)) {
                label.accelerator = Gtk.accelerator_name(keyval, mods);
                settings.set_strv('keyboard-shortcut',
                    label.accelerator ? [label.accelerator] : []);
                dialog.close();
            }
            return true;
        });
        dialog.add_controller(controller);

        dialog.connect('response', (_d, response) => {
            if (response === 'clear') {
                settings.set_strv('keyboard-shortcut', []);
            }
            dialog.destroy();
        });

        dialog.present();
    }
}
