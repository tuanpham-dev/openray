//! Multi-format clipboard writes on Wayland, via `wl-clipboard-rs`'s
//! `wlr-data-control` client (`copy_multi`). Compositors that don't
//! implement that protocol — notably GNOME/Mutter — return
//! `Error::MissingProtocol`, which `set_offer` turns into `Err`, sending
//! the caller (`clipboard_multi::set_offer`'s caller in
//! `application::screenshots`) down the arboard fallback ladder rather
//! than doing nothing.
//!
//! Unlike the X11 backend, `copy_multi`'s API takes ownership of the
//! source bytes up front rather than serving requests lazily, so
//! `Payload::LazyPngFromFile` is decoded and PNG-encoded here at claim
//! time instead of on first request.

use wl_clipboard_rs::copy::{Error, MimeSource, MimeType, Options, Source};

use super::{OfferEntry, Payload};

pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    let sources = build_sources(entries)?;
    let mut opts = Options::new();
    // `copy_multi` without this flag blocks until the offer is replaced —
    // fine for a CLI tool, not for a Tauri IPC handler.
    opts.foreground(false);
    opts.copy_multi(sources).map_err(|e: Error| e.to_string())
}

fn build_sources(entries: Vec<OfferEntry>) -> Result<Vec<MimeSource>, String> {
    entries
        .into_iter()
        .map(|entry| {
            let bytes = match entry.payload {
                Payload::Bytes(bytes) => bytes,
                Payload::LazyPngFromFile(path) => encode_png(&path)?,
            };
            Ok(MimeSource { source: Source::Bytes(bytes.into()), mime_type: MimeType::Specific(entry.target) })
        })
        .collect()
}

fn encode_png(path: &std::path::Path) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;

    let decoded = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(decoded.as_raw(), decoded.width(), decoded.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_sources_maps_each_entry_to_a_specific_mime_type() {
        let entries = vec![
            OfferEntry { target: "text/uri-list".into(), payload: Payload::Bytes(b"file:///a.png".to_vec()) },
            OfferEntry { target: "image/png".into(), payload: Payload::Bytes(vec![1, 2, 3]) },
        ];
        let sources = build_sources(entries).unwrap();

        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].mime_type, MimeType::Specific("text/uri-list".into()));
        assert_eq!(sources[1].mime_type, MimeType::Specific("image/png".into()));
        assert!(!sources.iter().any(|s| s.mime_type == MimeType::Specific("TARGETS".into())));
    }
}
