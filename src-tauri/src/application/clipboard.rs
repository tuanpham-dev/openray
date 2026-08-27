use rusqlite::params;
use serde::Serialize;

use crate::domain::ports::PasteInjector;
use crate::infrastructure::db::SharedConnection;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: String,
    /// Empty for image entries — the frontend switches on `kind`.
    pub text: String,
    pub created_at: i64,
    /// `"text"` or `"image"`.
    pub kind: String,
    pub image_path: Option<String>,
    pub image_width: Option<i64>,
    pub image_height: Option<i64>,
    /// Size of the backing PNG, for the preview's Information panel.
    pub image_bytes: Option<u64>,
}

pub struct ClipboardHistoryProvider {
    conn: SharedConnection,
    paste_injector: Box<dyn PasteInjector>,
}

impl ClipboardHistoryProvider {
    pub fn new(conn: SharedConnection, paste_injector: Box<dyn PasteInjector>) -> Self {
        Self { conn, paste_injector }
    }

    pub fn list(&self) -> Vec<ClipboardEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, text_content, created_at, kind, image_path, image_width, image_height
                 FROM clipboard_history ORDER BY created_at DESC",
            )
            .expect("valid query");
        let rows = stmt
            .query_map([], |row| {
                let image_path: Option<String> = row.get(4)?;
                // Read on demand rather than stored: the file can be
                // removed out from under us (trimmed, or cleaned up by the
                // user), and a stale size would be worse than none.
                let image_bytes = image_path
                    .as_deref()
                    .and_then(|path| std::fs::metadata(path).ok())
                    .map(|meta| meta.len());
                Ok(ClipboardEntry {
                    id: row.get(0)?,
                    text: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    created_at: row.get(2)?,
                    kind: row.get(3)?,
                    image_path,
                    image_width: row.get(5)?,
                    image_height: row.get(6)?,
                    image_bytes,
                })
            })
            .expect("valid query");
        rows.filter_map(Result::ok).collect()
    }

    pub fn find(&self, id: &str) -> Option<ClipboardEntry> {
        self.list().into_iter().find(|entry| entry.id == id)
    }

    pub fn paste(&self, id: &str) -> Result<(), String> {
        let entry = self.find(id).ok_or_else(|| format!("unknown clipboard entry '{id}'"))?;

        // Images can't be typed: put the picture on the clipboard and let
        // the injector send the paste keystroke, rather than the injector's
        // usual set-text-then-paste path.
        if entry.kind == "image" {
            self.copy(id)?;
            self.paste_injector.paste_current_clipboard()?;
            return Ok(());
        }

        self.paste_injector.paste(&entry.text)?;
        Ok(())
    }

    pub fn copy(&self, id: &str) -> Result<(), String> {
        let entry = self.find(id).ok_or_else(|| format!("unknown clipboard entry '{id}'"))?;
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;

        if let Some(path) = entry.image_path.as_deref() {
            let decoded = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
            let (width, height) = decoded.dimensions();
            return clipboard
                .set_image(arboard::ImageData {
                    width: width as usize,
                    height: height as usize,
                    bytes: decoded.into_raw().into(),
                })
                .map_err(|e| e.to_string());
        }

        clipboard.set_text(entry.text).map_err(|e| e.to_string())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let image_path = self.find(id).and_then(|entry| entry.image_path);

        {
            let conn = self.conn.lock().unwrap();
            conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }

        // After the row is gone, so a failed unlink can't leave a row
        // pointing at a missing file.
        if let Some(path) = image_path {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn clear_all(&self) -> Result<(), String> {
        let image_paths: Vec<String> = self.list().into_iter().filter_map(|entry| entry.image_path).collect();

        {
            let conn = self.conn.lock().unwrap();
            conn.execute("DELETE FROM clipboard_history", []).map_err(|e| e.to_string())?;
        }

        for path in image_paths {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }
}
