/// Wayland clipboard monitor using the ext-data-control-v1 protocol with a
/// zwlr-data-control-v1 fallback for wlroots-based compositors. GNOME's Mutter
/// exposes neither, so on GNOME this monitor does not bind and clipboard
/// content arrives from the extension via Meta.Selection + SubmitItem.
///
/// Runs on a dedicated OS thread (NOT on the tokio runtime) to avoid blocking
/// the async executor. Communicates clipboard change events to the tokio world
/// via an `mpsc::UnboundedSender`.
///
/// Protocol reference: staging/ext-data-control/ext-data-control-v1.xml
use std::collections::HashMap;

use anyhow::{bail, Result};
use tokio::sync::mpsc::UnboundedSender;
use wayland_client::{
    backend::ObjectId,
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_registry, wl_seat},
    Connection, Dispatch, Proxy, QueueHandle,
};
use wayland_protocols::ext::data_control::v1::client::{
    ext_data_control_device_v1::{self, ExtDataControlDeviceV1},
    ext_data_control_manager_v1::{self, ExtDataControlManagerV1},
    ext_data_control_offer_v1::{self, ExtDataControlOfferV1},
};
use wayland_protocols_wlr::data_control::v1::client::{
    zwlr_data_control_device_v1::{self, ZwlrDataControlDeviceV1},
    zwlr_data_control_manager_v1::{self, ZwlrDataControlManagerV1},
    zwlr_data_control_offer_v1::{self, ZwlrDataControlOfferV1},
};

/// A clipboard change notification: the compositor has set a new selection.
/// `mime_types` lists all MIME types the new selection provides.
#[derive(Debug)]
pub struct ClipboardChange {
    pub mime_types: Vec<String>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct MonitorState {
    /// Pending offers keyed by Wayland object ID.
    /// Each entry holds the offered MIME types as they arrive.
    offers: HashMap<ObjectId, Vec<String>>,
    tx: UnboundedSender<ClipboardChange>,
}

impl MonitorState {
    fn new(tx: UnboundedSender<ClipboardChange>) -> Self {
        Self {
            offers: HashMap::new(),
            tx,
        }
    }

    fn record_offer_mime(&mut self, id: ObjectId, mime: String) {
        self.offers.entry(id).or_default().push(mime);
    }

    fn commit_selection(&mut self, offer_id: ObjectId) {
        // Take the mime list for this offer (and discard stale in-flight offers).
        let mimes = self.offers.remove(&offer_id).unwrap_or_default();
        self.offers.clear(); // discard any superseded offers
        if !mimes.is_empty() {
            let _ = self.tx.send(ClipboardChange { mime_types: mimes });
        }
    }
}

// ---------------------------------------------------------------------------
// WlRegistry - required by registry_queue_init
// ---------------------------------------------------------------------------

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for MonitorState {
    fn event(
        _state: &mut Self,
        _proxy: &wl_registry::WlRegistry,
        _event: wl_registry::Event,
        _data: &GlobalListContents,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        // Handled by GlobalList inside registry_queue_init.
    }
}

// ---------------------------------------------------------------------------
// ext-data-control-v1
// ---------------------------------------------------------------------------

impl Dispatch<ExtDataControlManagerV1, ()> for MonitorState {
    fn event(
        _: &mut Self,
        _: &ExtDataControlManagerV1,
        _: ext_data_control_manager_v1::Event, // manager has no events - unreachable
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtDataControlDeviceV1, ()> for MonitorState {
    fn event(
        state: &mut Self,
        _device: &ExtDataControlDeviceV1,
        event: ext_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            ext_data_control_device_v1::Event::DataOffer { id } => {
                // Register the new offer object so subsequent Offer events can
                // find it.
                state.offers.insert(id.id(), Vec::new());
            }
            ext_data_control_device_v1::Event::Selection { id: Some(offer) } => {
                let oid = offer.id();
                state.commit_selection(oid);
                // Politely destroy the offer - the compositor will clean up
                // the Wayland object.
                offer.destroy();
            }
            ext_data_control_device_v1::Event::Selection { id: None } => {
                // null id means "clipboard cleared" - ignore.
            }
            ext_data_control_device_v1::Event::Finished => {
                tracing::warn!("ext-data-control device finished (compositor revoked access)");
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtDataControlOfferV1, ()> for MonitorState {
    fn event(
        state: &mut Self,
        proxy: &ExtDataControlOfferV1,
        event: ext_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let ext_data_control_offer_v1::Event::Offer { mime_type } = event {
            state.record_offer_mime(proxy.id(), mime_type);
        }
    }
}

// ---------------------------------------------------------------------------
// zwlr-data-control-v1  (fallback for wlroots compositors)
// ---------------------------------------------------------------------------

impl Dispatch<ZwlrDataControlManagerV1, ()> for MonitorState {
    fn event(
        _: &mut Self,
        _: &ZwlrDataControlManagerV1,
        _: zwlr_data_control_manager_v1::Event, // manager has no events - unreachable
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrDataControlDeviceV1, ()> for MonitorState {
    fn event(
        state: &mut Self,
        _device: &ZwlrDataControlDeviceV1,
        event: zwlr_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_data_control_device_v1::Event::DataOffer { id } => {
                state.offers.insert(id.id(), Vec::new());
            }
            zwlr_data_control_device_v1::Event::Selection { id: Some(offer) } => {
                let oid = offer.id();
                state.commit_selection(oid);
                offer.destroy();
            }
            zwlr_data_control_device_v1::Event::Selection { id: None } => {}

            zwlr_data_control_device_v1::Event::Finished => {
                tracing::warn!("zwlr-data-control device finished");
            }
            _ => {}
        }
    }
}

impl Dispatch<ZwlrDataControlOfferV1, ()> for MonitorState {
    fn event(
        state: &mut Self,
        proxy: &ZwlrDataControlOfferV1,
        event: zwlr_data_control_offer_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zwlr_data_control_offer_v1::Event::Offer { mime_type } = event {
            state.record_offer_mime(proxy.id(), mime_type);
        }
    }
}

// wl_seat - needed for binding, no events we care about.
wayland_client::delegate_noop!(MonitorState: ignore wl_seat::WlSeat);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Spawn the clipboard monitor on a dedicated OS thread.
/// Returns immediately; the thread sends `ClipboardChange` events via `tx`.
pub fn spawn(tx: UnboundedSender<ClipboardChange>) -> Result<()> {
    let conn = Connection::connect_to_env()
        .map_err(|e| anyhow::anyhow!("Could not connect to Wayland display: {e}"))?;

    // Probe available protocols with a throwaway state.
    let protocol = probe_protocol(&conn)?;
    tracing::info!("Clipboard monitor using protocol: {:?}", protocol);

    std::thread::Builder::new()
        .name("strata-wl-monitor".into())
        .spawn(move || {
            if let Err(e) = run_loop(conn, protocol, tx) {
                tracing::error!("Clipboard monitor exited with error: {e:#}");
            }
        })?;

    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum Protocol {
    Ext,
    Wlr,
}

fn probe_protocol(conn: &Connection) -> Result<Protocol> {
    // A quick roundtrip to get the global list; no persistent state needed here.
    let (globals, _) = registry_queue_init::<MonitorState>(conn)?;

    // ext-data-control-v1 preferred (KDE Plasma 6 and other compositors that
    // expose it). GNOME's Mutter does NOT expose it, so this probe fails on
    // GNOME and ingest falls back to the extension's SubmitItem path.
    if globals.contents().with_list(|list| {
        list.iter()
            .any(|g| g.interface == "ext_data_control_manager_v1")
    }) {
        return Ok(Protocol::Ext);
    }

    // zwlr-data-control-v1 fallback (wlroots: Sway, Hyprland, etc.)
    if globals.contents().with_list(|list| {
        list.iter()
            .any(|g| g.interface == "zwlr_data_control_manager_v1")
    }) {
        return Ok(Protocol::Wlr);
    }

    bail!(
        "No supported clipboard control protocol found.\n\
         - GNOME: Mutter exposes neither protocol; ingest comes from the\n\
           extension via Meta.Selection + SubmitItem (this is expected).\n\
         - wlroots: requires zwlr-data-control-v1 (Sway, Hyprland, etc.)"
    );
}

fn run_loop(
    conn: Connection,
    protocol: Protocol,
    tx: UnboundedSender<ClipboardChange>,
) -> Result<()> {
    let (globals, mut queue) = registry_queue_init::<MonitorState>(&conn)?;
    let qh = queue.handle();
    let mut state = MonitorState::new(tx);

    // First roundtrip to populate globals.
    queue.roundtrip(&mut state)?;

    let seat: wl_seat::WlSeat = globals.bind(&qh, 1..=8, ())?;

    match protocol {
        Protocol::Ext => {
            let manager: ExtDataControlManagerV1 = globals
                .bind(&qh, 1..=1, ())
                .map_err(|e| anyhow::anyhow!("Could not bind ext_data_control_manager_v1: {e}"))?;
            let _device = manager.get_data_device(&seat, &qh, ());
            // Roundtrip to ensure the device creation is acknowledged and the
            // initial selection offer (if any) is delivered.
            queue.roundtrip(&mut state)?;
        }
        Protocol::Wlr => {
            let manager: ZwlrDataControlManagerV1 = globals
                .bind(&qh, 2..=2, ())
                .map_err(|e| anyhow::anyhow!("Could not bind zwlr_data_control_manager_v1: {e}"))?;
            let _device = manager.get_data_device(&seat, &qh, ());
            queue.roundtrip(&mut state)?;
        }
    }

    tracing::info!("Clipboard monitor event loop running");

    // Main event loop: blocks until an event is available, then dispatches it.
    loop {
        if let Err(e) = queue.blocking_dispatch(&mut state) {
            tracing::error!("Wayland dispatch error: {e}");
            break;
        }
    }

    Ok(())
}
