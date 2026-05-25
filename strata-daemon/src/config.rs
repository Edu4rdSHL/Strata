use std::path::PathBuf;

pub struct Config {
    pub db_path: PathBuf,
    pub max_history: usize,
}

impl Config {
    pub fn new() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("strata");

        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            tracing::warn!("Could not create data dir {:?}: {}", data_dir, e);
        }

        Self {
            db_path: data_dir.join("clipboard.db"),
            max_history: 200,
        }
    }
}
