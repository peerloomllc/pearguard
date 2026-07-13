// PearGuard Focus Reporter — minimal GNOME Shell extension that exposes the
// currently-focused window over D-Bus so PearGuard's enforcement can read it
// on Wayland sessions. Mutter doesn't expose this information to unprivileged
// processes by design; org.gnome.Shell.Eval is also disabled by GNOME 41+
// hardening. Hence a tiny in-Shell extension.
//
// Wire: PearGuard's foreground-wayland.js calls gdbus once per second
// against com.peerloomllc.PearGuardFocus / GetFocus().
//
// Targets GNOME 45+ (ESM module loader). Older Shells use the imports.* style
// and would need a separate extension build.
//
// DO NOT add "session-modes" to metadata.json. Its absence means GNOME defaults
// to ["user"] and DISABLES this extension on the lock screen, which unexports
// the bus name below. That is load-bearing: PearGuard's usage tracker relies on
// the resulting D-Bus failure to notice the screen locked, because Electron's
// powerMonitor 'lock-screen' event does not fire on Linux. Adding
// "unlock-dialog" would keep GetFocus() reporting the last focused window while
// the screen is locked, and the child would silently accrue phantom foreground
// time (measured: 190 phantom seconds across a 3-minute lock) that also eats
// their screen-time budget. See the LOCK-SCREEN SAFETY note in
// desktop/src/enforcement/foreground-wayland.js before changing this.

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import Gio from 'gi://Gio'

const BUS_NAME = 'com.peerloomllc.PearGuardFocus'
const OBJECT_PATH = '/com/peerloomllc/PearGuardFocus'

// (pid, title, wmClass, wmClassInstance). All strings; pid is uint32 so a
// missing PID returns 0 rather than throwing a type mismatch on the wire.
const INTROSPECTION_XML = `
<node>
  <interface name="com.peerloomllc.PearGuardFocus">
    <method name="GetFocus">
      <arg type="u" direction="out" name="pid"/>
      <arg type="s" direction="out" name="title"/>
      <arg type="s" direction="out" name="wmClass"/>
      <arg type="s" direction="out" name="wmClassInstance"/>
    </method>
  </interface>
</node>`

export default class PearGuardFocusExtension extends Extension {
  enable() {
    this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(INTROSPECTION_XML, this)
    this._dbusImpl.export(Gio.DBus.session, OBJECT_PATH)
    // Take the bus name. REPLACE so a stale instance after a Shell crash
    // doesn't lock us out. ALLOW_REPLACEMENT in case the next install wants
    // to take over.
    this._busNameId = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      BUS_NAME,
      Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
      null,
      null,
    )
  }

  disable() {
    if (this._dbusImpl) {
      this._dbusImpl.unexport()
      this._dbusImpl = null
    }
    if (this._busNameId) {
      Gio.bus_unown_name(this._busNameId)
      this._busNameId = 0
    }
  }

  // D-Bus method. Returns (uint32 pid, str title, str wmClass, str instance).
  // Empty strings + pid=0 when nothing is focused (e.g. desktop). Polled by
  // the enforcement controller on a 1s tick, so this needs to be cheap; all
  // reads go through Mutter's already-cached MetaWindow state.
  GetFocus() {
    const focus = global.display.get_focus_window()
    if (!focus) return [0, '', '', '']
    const pid = focus.get_pid() || 0
    const title = focus.get_title() || ''
    const wmClass = focus.get_wm_class() || ''
    const wmClassInstance = focus.get_wm_class_instance
      ? (focus.get_wm_class_instance() || '')
      : ''
    return [pid, title, wmClass, wmClassInstance]
  }
}
