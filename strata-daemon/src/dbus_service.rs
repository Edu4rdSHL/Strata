use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use zbus::{interface, object_server::SignalEmitter};

use crate::db::{Db, RawItem};

/// Maximum thumbnail dimension for images (px). Larger images are resized down.
pub const THUMB_PX: u32 = 200;
/// Default maximum raw image size to accept (bytes). Overridable via `SetConfig`.
pub const DEFAULT_MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// Default maximum text size to accept. Overridable via `SetConfig`.
pub const DEFAULT_MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Default maximum history item count. Overridable via `SetConfig`.
pub const DEFAULT_MAX_HISTORY: usize = 200;

/// Runtime-configurable limits shared between the D-Bus service and the
/// clipboard processing tasks. All three are read on every ingest / prune
/// call, so updates via `SetConfig` take effect immediately.
#[derive(Clone)]
pub struct Limits {
    pub max_history: Arc<AtomicUsize>,
    pub max_text_bytes: Arc<AtomicUsize>,
    pub max_image_bytes: Arc<AtomicUsize>,
}

impl Limits {
    pub fn with_defaults() -> Self {
        Self {
            max_history: Arc::new(AtomicUsize::new(DEFAULT_MAX_HISTORY)),
            max_text_bytes: Arc::new(AtomicUsize::new(DEFAULT_MAX_TEXT_BYTES)),
            max_image_bytes: Arc::new(AtomicUsize::new(DEFAULT_MAX_IMAGE_BYTES)),
        }
    }
    pub fn max_history(&self) -> usize {
        self.max_history.load(Ordering::Relaxed)
    }
    pub fn max_text_bytes(&self) -> usize {
        self.max_text_bytes.load(Ordering::Relaxed)
    }
    pub fn max_image_bytes(&self) -> usize {
        self.max_image_bytes.load(Ordering::Relaxed)
    }
}

/// Submitted by the GJS extension via D-Bus (Meta.Selection path).
pub struct SubmitRequest {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub struct StrataManager {
    pub db: Arc<Db>,
    pub limits: Limits,
    pub submit_tx: tokio::sync::mpsc::UnboundedSender<SubmitRequest>,
    /// Send a `()` here to trigger graceful shutdown from the D-Bus Shutdown method.
    pub shutdown_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

#[interface(name = "dev.edu4rdshl.Strata.Manager")]
impl StrataManager {
    /// Called by the GJS extension when it detects a clipboard change via Meta.Selection.
    /// `content` is the raw bytes of the clipboard payload (D-Bus `ay`).
    ///
    /// Trust note: the password-manager hint (`x-kde-passwordManagerHint`) is
    /// honored client-side by the extension before it ever calls this, but the
    /// hint is not forwarded, so this method cannot re-check it. Treat callers of
    /// `SubmitItem` as trusted (the session bus is per-user). Forwarding the
    /// sensitivity flag to enforce it here is left for a future contract change.
    // async is required by the zbus #[interface] method signature, not by the body.
    #[allow(clippy::unused_async)]
    async fn submit_item(&self, mime_type: String, content: Vec<u8>) -> zbus::fdo::Result<()> {
        self.submit_tx
            .send(SubmitRequest {
                mime_type,
                bytes: content,
            })
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }
    /// Return a page of recent items as JSON metadata (no inline thumbnail bytes,
    /// `content_text` truncated to a preview). Clients call GetThumbnail(id) lazily
    /// for items with `has_thumbnail=true` and GetItemContent(id) for full content.
    /// `offset` is from the most recent item (0 = newest).
    async fn get_history(&self, offset: u32, limit: u32) -> zbus::fdo::Result<String> {
        let db = self.db.clone();
        let max = self.limits.max_history();
        let items = tokio::task::spawn_blocking(move || {
            db.get_history_page(offset as usize, limit as usize, max)
        })
        .await
        .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
        .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;

        serde_json::to_string(&items).map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    /// Full-text search across the entire DB. Empty query returns []; callers
    /// should fall back to `GetHistory` in that case.
    async fn search_history(&self, query: String, limit: u32) -> zbus::fdo::Result<String> {
        let db = self.db.clone();
        let items = tokio::task::spawn_blocking(move || db.search_history(&query, limit as usize))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;

        serde_json::to_string(&items).map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    /// Fetch a thumbnail's raw PNG bytes. Returns empty array if the item has no
    /// thumbnail or doesn't exist (clients can fall back to a placeholder).
    async fn get_thumbnail(&self, id: String) -> zbus::fdo::Result<Vec<u8>> {
        let db = self.db.clone();
        let bytes = tokio::task::spawn_blocking(move || db.get_thumbnail(&id))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;
        Ok(bytes.unwrap_or_default())
    }

    /// Return the raw content of a clipboard item for GJS to write to clipboard.
    /// GJS uses St.Clipboard (text) or Meta.SelectionSourceMemory (images)
    /// because the Wayland data-control protocol is not accessible from non-compositor processes.
    /// Content is returned as a raw byte array (`ay`) — no base64 round-trip.
    async fn get_item_content(&self, id: String) -> zbus::fdo::Result<(String, Vec<u8>)> {
        let db = self.db.clone();
        let item: Option<RawItem> = tokio::task::spawn_blocking(move || db.get_raw_item(&id))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;

        let item = item.ok_or_else(|| zbus::fdo::Error::Failed("Item not found".into()))?;

        let content = if let Some(text) = item.content_text {
            text.into_bytes()
        } else if let Some(blob) = item.content_blob {
            blob
        } else {
            return Err(zbus::fdo::Error::Failed("Item has no content".into()));
        };

        Ok((item.mime_type, content))
    }

    /// Restore a clipboard item to the system clipboard.
    async fn set_clipboard(&self, id: String) -> zbus::fdo::Result<()> {
        let db = self.db.clone();
        let item: Option<RawItem> = tokio::task::spawn_blocking(move || db.get_raw_item(&id))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;

        let item = item.ok_or_else(|| zbus::fdo::Error::Failed("Item not found".into()))?;

        let content = if let Some(text) = item.content_text {
            crate::clipboard::writer::WriteRequest {
                mime_type: item.mime_type,
                content: text.into_bytes(),
            }
        } else if let Some(blob) = item.content_blob {
            crate::clipboard::writer::WriteRequest {
                mime_type: item.mime_type,
                content: blob,
            }
        } else {
            return Err(zbus::fdo::Error::Failed("Item has no content".into()));
        };

        tokio::task::spawn_blocking(move || crate::clipboard::writer::write_to_clipboard(content))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    /// Remove a single item from history.
    async fn delete_item(
        &self,
        id: String,
        #[zbus(signal_context)] ctx: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let db = self.db.clone();
        let id_clone = id.clone();
        tokio::task::spawn_blocking(move || db.delete_item(&id_clone))
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;

        Self::item_deleted(&ctx, &id)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    /// Remove all items from history.
    async fn clear_history(
        &self,
        #[zbus(signal_context)] ctx: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.clear_history())
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;

        Self::history_cleared(&ctx)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    /// Push runtime limits from the front-end. Takes effect immediately.
    /// All three values are absolute (`max_text` and `max_image` are bytes,
    /// not MB). 0 means "leave unchanged" for that field.
    async fn set_config(
        &self,
        max_history: u32,
        max_text_bytes: u32,
        max_image_bytes: u32,
        #[zbus(signal_context)] ctx: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        use std::sync::atomic::Ordering;
        if max_history > 0 {
            self.limits
                .max_history
                .store(max_history as usize, Ordering::Relaxed);
        }
        if max_text_bytes > 0 {
            self.limits
                .max_text_bytes
                .store(max_text_bytes as usize, Ordering::Relaxed);
        }
        if max_image_bytes > 0 {
            self.limits
                .max_image_bytes
                .store(max_image_bytes as usize, Ordering::Relaxed);
        }
        tracing::info!(
            "SetConfig: max_history={}, max_text={} B, max_image={} B",
            self.limits.max_history(),
            self.limits.max_text_bytes(),
            self.limits.max_image_bytes(),
        );

        // Lowering max_history should shrink stored history immediately, not
        // wait until the next copy triggers a prune. Prune now and emit
        // ItemDeleted for each removed id so clients can drop their caches.
        if max_history > 0 {
            let db = self.db.clone();
            let max = max_history as usize;
            let pruned = tokio::task::spawn_blocking(move || db.prune(max))
                .await
                .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?
                .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;
            for id in &pruned {
                if let Err(e) = Self::item_deleted(&ctx, id).await {
                    tracing::warn!("Emitting ItemDeleted for pruned id={}: {}", id, e);
                }
            }
        }
        Ok(())
    }

    /// Gracefully shut down the daemon.
    // async is required by the zbus #[interface] method signature, not by the body.
    #[allow(clippy::unused_async)]
    async fn shutdown(&self) {
        tracing::info!("Shutdown requested via D-Bus");
        // Signal the main loop to exit. The reply is sent before the process exits
        // because we return normally from this method; the main loop exits shortly after.
        let _ = self.shutdown_tx.send(());
    }

    // -----------------------------------------------------------------
    // Signals
    // -----------------------------------------------------------------

    /// Emitted when a new item is stored (after dedup + thumbnail generation).
    /// `preview` is a text excerpt (≤ `PREVIEW_CHARS`) for text items, or empty for
    /// images and other binary types - clients should call GetThumbnail(id) to
    /// fetch image thumbnails lazily.
    #[zbus(signal)]
    pub async fn item_added(
        ctx: &SignalEmitter<'_>,
        id: &str,
        mime_type: &str,
        preview: &str,
    ) -> zbus::Result<()>;

    /// Emitted when an item is removed.
    #[zbus(signal)]
    pub async fn item_deleted(ctx: &SignalEmitter<'_>, id: &str) -> zbus::Result<()>;

    /// Emitted when the entire history is cleared.
    #[zbus(signal)]
    pub async fn history_cleared(ctx: &SignalEmitter<'_>) -> zbus::Result<()>;
}
