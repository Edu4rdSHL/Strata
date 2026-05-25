mod clipboard;
mod config;
mod db;
mod dbus_service;

use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine as _;
use dbus_service::{Limits, StrataManager, SubmitRequest, THUMB_PX};
use tokio::sync::{mpsc, Mutex};
use tracing_subscriber::EnvFilter;
use wl_clipboard_rs::paste::{get_contents, ClipboardType, MimeType, Seat};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    tracing::info!("Strata daemon starting");

    let cfg = config::Config::new();
    let db = Arc::new(db::Db::open(&cfg.db_path).context("Opening database")?);
    let focused_app = Arc::new(Mutex::new(String::new()));
    let limits = Limits::with_defaults();
    limits
        .max_history
        .store(cfg.max_history, std::sync::atomic::Ordering::Relaxed);

    // -----------------------------------------------------------------------
    // Channels
    // -----------------------------------------------------------------------
    // Wayland-monitor path: daemon reads clipboard bytes itself.
    let (clip_tx, mut clip_rx) = mpsc::unbounded_channel::<clipboard::monitor::ClipboardChange>();
    // GJS submit path: GJS reads via Meta.Selection, sends bytes over D-Bus.
    let (submit_tx, mut submit_rx) = mpsc::unbounded_channel::<SubmitRequest>();
    // D-Bus Shutdown method path.
    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();

    // -----------------------------------------------------------------------
    // D-Bus service
    // -----------------------------------------------------------------------
    let manager = StrataManager {
        db: db.clone(),
        limits: limits.clone(),
        focused_app: focused_app.clone(),
        submit_tx,
        shutdown_tx,
    };

    let dbus_conn = zbus::connection::Builder::session()?
        .serve_at("/org/gnome/Strata", manager)?
        .build()
        .await
        .context("Building D-Bus connection")?;

    // Request the well-known name with ReplaceExisting so a new instance always
    // wins the race against the outgoing instance during extension reload.
    dbus_conn
        .request_name_with_flags(
            "org.gnome.Strata",
            zbus::fdo::RequestNameFlags::ReplaceExisting.into(),
        )
        .await
        .context("Acquiring D-Bus name org.gnome.Strata")?;

    tracing::info!("D-Bus service registered as org.gnome.Strata");

    // -----------------------------------------------------------------------
    // Clipboard monitor (Wayland protocols - optional, soft-fail on GNOME)
    // GJS provides clipboard content via SubmitItem when this is unavailable.
    // -----------------------------------------------------------------------
    match clipboard::monitor::spawn(clip_tx) {
        Ok(()) => tracing::info!("Wayland clipboard monitor started"),
        Err(_) => tracing::info!(
            "Wayland clipboard monitor unavailable, using GJS Meta.Selection path (expected on GNOME)"
        ),
    }

    // -----------------------------------------------------------------------
    // Clipboard processing tasks
    // -----------------------------------------------------------------------
    let db_clone = db.clone();
    let conn_clone = dbus_conn.clone();
    let limits_clone = limits.clone();

    // Wayland-monitor path.
    tokio::spawn(async move {
        while let Some(change) = clip_rx.recv().await {
            if let Err(e) =
                process_change(&change.mime_types, &db_clone, &conn_clone, &limits_clone).await
            {
                tracing::warn!("Error processing Wayland clipboard change: {e:#}");
            }
        }
    });

    let db_submit = db.clone();
    let conn_submit = dbus_conn.clone();
    let limits_submit = limits.clone();

    // GJS submit path.
    tokio::spawn(async move {
        while let Some(req) = submit_rx.recv().await {
            if let Err(e) = process_bytes(
                req.mime_type,
                req.bytes,
                &db_submit,
                &conn_submit,
                &limits_submit,
            )
            .await
            {
                tracing::warn!("Error processing submitted clipboard item: {e:#}");
            }
        }
    });

    // -----------------------------------------------------------------------
    // Graceful shutdown on SIGTERM / SIGINT
    // -----------------------------------------------------------------------
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;

    tokio::select! {
        _ = sigterm.recv()    => { tracing::info!("Received SIGTERM, shutting down"); }
        _ = sigint.recv()     => { tracing::info!("Received SIGINT, shutting down"); }
        _ = shutdown_rx.recv() => { tracing::info!("Shutdown via D-Bus, shutting down"); }
    }

    Ok(())
}

/// Select the best MIME type to store from a list of offered types.
///
/// Priority: images > plain text > rich text (html/rtf) > file URIs.
///
/// Plain text is intentionally ranked above text/html and text/rtf so that
/// when an application (e.g. a code editor or web browser) advertises both a
/// rich-text variant and a plain-text variant, we capture the plain text. This
/// avoids storing syntax-highlighted HTML markup instead of source code.
/// Rich-text types are still captured when no plain-text alternative is offered.
fn pick_mime(mimes: &[String]) -> Option<&str> {
    const PREFERRED: &[&str] = &[
        // Raster images (size-capped at MAX_IMAGE_BYTES).
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/tiff",
        "image/avif",
        "image/x-icon",
        "image/svg+xml",
        // Plain text (UTF-8 preferred, then locale, then X11 legacy aliases).
        // Ranked above rich-text so editors that expose both text/plain and
        // text/html give us the raw source, not styled markup.
        "text/plain;charset=utf-8",
        "UTF8_STRING",
        "text/plain",
        "STRING",
        "TEXT",
        // Rich text -- only reached when no plain-text offer is available.
        "text/html",
        "text/rtf",
        "application/rtf",
        "text/markdown",
        // File-manager copy/cut payloads (URI list, not bytes).
        "x-special/gnome-copied-files",
        "x-special/nautilus-clipboard",
        "application/x-kde-cutselection",
        "text/uri-list",
    ];
    // Allowlist only: accepting arbitrary mimes would force us to read
    // potentially huge payloads (1 GB binaries, etc.) before we could
    // size-check them. Unknown mimes are silently dropped.
    PREFERRED
        .iter()
        .find(|&&want| mimes.iter().any(|m| m == want))
        .copied()
}

async fn process_change(
    mime_types: &[String],
    db: &Arc<db::Db>,
    conn: &zbus::Connection,
    limits: &Limits,
) -> Result<()> {
    // Password managers (KeePassXC, KeePass, some Bitwarden builds) mark
    // copied secrets with this mime hint. Skip the change entirely so we
    // never store the password.
    if mime_types.iter().any(|m| m == "x-kde-passwordManagerHint") {
        tracing::debug!("Skipping clipboard change marked as sensitive");
        return Ok(());
    }
    let mime = match pick_mime(mime_types) {
        Some(m) => m.to_string(),
        None => {
            tracing::debug!("No usable MIME type in {:?}", mime_types);
            return Ok(());
        }
    };

    tracing::debug!("Processing Wayland clipboard change, MIME: {}", mime);

    let mime_clone = mime.clone();
    let (raw_bytes, actual_mime) =
        tokio::task::spawn_blocking(move || read_clipboard_bytes(&mime_clone))
            .await?
            .context("Reading clipboard content")?;

    if raw_bytes.is_empty() {
        return Ok(());
    }

    process_bytes(actual_mime, raw_bytes, db, conn, limits).await
}

/// Core storage path - shared by the Wayland-monitor and GJS-submit paths.
async fn process_bytes(
    mime: String,
    raw_bytes: Vec<u8>,
    db: &Arc<db::Db>,
    conn: &zbus::Connection,
    limits: &Limits,
) -> Result<()> {
    if raw_bytes.is_empty() {
        return Ok(());
    }

    let is_image = mime.starts_with("image/");

    // Enforce size limits
    let max = if is_image {
        limits.max_image_bytes()
    } else {
        limits.max_text_bytes()
    };
    if raw_bytes.len() > max {
        tracing::debug!(
            "Clipboard item too large ({} bytes, limit {}), skipping",
            raw_bytes.len(),
            max
        );
        return Ok(());
    }

    // Compute content hash for deduplication
    let hash = blake3::hash(&raw_bytes).to_hex().to_string();

    // For images: generate a thumbnail in spawn_blocking; store original as blob, thumbnail separately.
    // For text: store as UTF-8 string.
    // The `preview` string emitted with the ItemAdded signal is now ALWAYS a text excerpt;
    // image thumbnails are fetched lazily by clients via GetThumbnail(id) to keep the
    // signal payload small (and consistent with paginated GetHistory results).
    let (content_text, content_blob, thumbnail_blob, preview) = if is_image {
        let raw_for_thumb = raw_bytes.clone();
        let thumb_result =
            tokio::task::spawn_blocking(move || make_thumbnail(&raw_for_thumb, THUMB_PX)).await?;

        let thumb_bytes = match thumb_result {
            Ok((bytes, _b64)) => bytes,
            Err(e) => {
                tracing::warn!("Image thumbnail generation failed: {e}");
                return Ok(());
            }
        };
        (None, Some(raw_bytes), Some(thumb_bytes), String::new())
    } else {
        let text = String::from_utf8_lossy(&raw_bytes).into_owned();
        let preview: String = text.chars().take(120).collect();
        (Some(text), None, None, preview)
    };

    let db_clone = db.clone();
    let mime_clone = mime.clone();
    let hash_clone = hash.clone();

    let (id, is_new) = tokio::task::spawn_blocking(move || {
        db_clone.upsert_item(
            &mime_clone,
            content_text.as_deref(),
            content_blob.as_deref(),
            thumbnail_blob.as_deref(),
            &hash_clone,
            None, // source_app is set via SetFocusedApp
        )
    })
    .await?
    .context("Upserting clipboard item")?;

    // Prune old items to stay within max_history limit.
    // Only needed when a genuinely new item was just inserted.
    let pruned_ids: Vec<String> = if is_new {
        let db_prune = db.clone();
        let max_history = limits.max_history();
        tokio::task::spawn_blocking(move || db_prune.prune(max_history))
            .await?
            .context("Pruning history")?
    } else {
        Vec::new()
    };

    if is_new {
        let iface = conn
            .object_server()
            .interface::<_, StrataManager>("/org/gnome/Strata")
            .await
            .context("Getting StrataManager interface ref")?;

        StrataManager::item_added(iface.signal_context(), &id, &mime, &preview)
            .await
            .context("Emitting ItemAdded signal")?;

        for pid in &pruned_ids {
            if let Err(e) = StrataManager::item_deleted(iface.signal_context(), pid).await {
                tracing::warn!("Emitting ItemDeleted for pruned id={}: {}", pid, e);
            }
        }

        tracing::debug!("Stored new clipboard item id={} mime={}", id, mime);
    } else {
        tracing::debug!("Promoted duplicate clipboard item id={}", id);
    }

    Ok(())
}

/// Read clipboard content using wl-clipboard-rs (opens its own Wayland connection).
/// Returns `(bytes, actual_mime_type)`.
fn read_clipboard_bytes(mime: &str) -> Result<(Vec<u8>, String)> {
    use std::io::Read;

    let (mut reader, actual_mime) = get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        MimeType::Specific(mime),
    )
    .map_err(|e| anyhow::anyhow!("wl-clipboard-rs read error: {e:?}"))?;

    let mut buf = Vec::new();
    reader.read_to_end(&mut buf)?;
    Ok((buf, actual_mime))
}

/// Generate a PNG thumbnail (≤`max_px`×`max_px`) from raw image bytes.
/// Returns `(thumbnail_bytes, base64_preview)`.
fn make_thumbnail(raw: &[u8], max_px: u32) -> Result<(Vec<u8>, String)> {
    let img = image::load_from_memory(raw).context("Decoding image")?;

    let thumb = img.thumbnail(max_px, max_px);
    let mut out = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .context("Encoding thumbnail")?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&out);
    Ok((out, b64))
}
