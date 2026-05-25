/**
 * dbus.js - Async D-Bus proxy for the Strata daemon.
 *
 * Uses Gio.DBusProxy.makeProxyWrapper to generate a typed proxy class.
 * All method calls should use the *Async variants (return Promises) to avoid
 * blocking the GNOME Shell compositor main loop.
 */

import Gio from 'gi://Gio';

const STRATA_IFACE_XML = `
<node>
  <interface name="org.gnome.Strata.Manager">

    <method name="GetHistory">
      <arg type="u" direction="in"  name="offset"/>
      <arg type="u" direction="in"  name="limit"/>
      <arg type="s" direction="out" name="json"/>
    </method>

    <method name="SearchHistory">
      <arg type="s" direction="in"  name="query"/>
      <arg type="u" direction="in"  name="limit"/>
      <arg type="s" direction="out" name="json"/>
    </method>

    <method name="GetThumbnail">
      <arg type="s"  direction="in"  name="id"/>
      <arg type="ay" direction="out" name="png_bytes"/>
    </method>

    <method name="GetItemContent">
      <arg type="s"  direction="in"  name="id"/>
      <arg type="s"  direction="out" name="mime_type"/>
      <arg type="ay" direction="out" name="content"/>
    </method>

    <method name="SetClipboard">
      <arg type="s" direction="in" name="id"/>
    </method>

    <method name="DeleteItem">
      <arg type="s" direction="in" name="id"/>
    </method>

    <method name="ClearHistory"/>

    <method name="Shutdown"/>

    <method name="SetConfig">
      <arg type="u" direction="in" name="max_history"/>
      <arg type="u" direction="in" name="max_text_bytes"/>
      <arg type="u" direction="in" name="max_image_bytes"/>
    </method>

    <method name="SubmitItem">
      <arg type="s"  direction="in" name="mime_type"/>
      <arg type="ay" direction="in" name="content"/>
    </method>

    <signal name="ItemAdded">
      <arg type="s" name="id"/>
      <arg type="s" name="mime_type"/>
      <arg type="s" name="preview"/>
    </signal>

    <signal name="ItemDeleted">
      <arg type="s" name="id"/>
    </signal>

    <signal name="HistoryCleared"/>

  </interface>
</node>`;

export const StrataProxy = Gio.DBusProxy.makeProxyWrapper(STRATA_IFACE_XML);

export const BUS_NAME    = 'org.gnome.Strata';
export const OBJECT_PATH = '/org/gnome/Strata';
