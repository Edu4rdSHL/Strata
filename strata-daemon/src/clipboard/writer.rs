/// Writes content back to the Wayland clipboard using wl-clipboard-rs.
/// `copy_multi(foreground: false)` spawns a background OS thread that serves
/// `wl_data_source.send` requests from other apps - the tokio runtime is
/// never blocked.
use anyhow::Result;
use wl_clipboard_rs::copy::{MimeSource, MimeType, Options, Source};

#[derive(Debug, Clone)]
pub struct WriteRequest {
    pub mime_type: String,
    pub content: Vec<u8>,
}

pub fn write_to_clipboard(req: WriteRequest) -> Result<()> {
    let WriteRequest {
        mime_type: mime,
        content: bytes,
    } = req;

    // For text, offer both the specific type and text/plain for compatibility.
    let sources: Vec<MimeSource> = if mime.starts_with("text/") {
        vec![
            MimeSource {
                source: Source::Bytes(bytes.clone().into()),
                mime_type: MimeType::Specific(mime),
            },
            MimeSource {
                source: Source::Bytes(bytes.into()),
                mime_type: MimeType::Specific("text/plain;charset=utf-8".into()),
            },
        ]
    } else {
        vec![MimeSource {
            source: Source::Bytes(bytes.into()),
            mime_type: MimeType::Specific(mime),
        }]
    };

    let mut opts = Options::new();
    opts.foreground(false);
    opts.copy_multi(sources)?;

    Ok(())
}
