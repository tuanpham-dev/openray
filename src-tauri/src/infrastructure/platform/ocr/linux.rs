use std::path::Path;
use std::process::Command;

const ENGINE_NAME: &str = "Tesseract";

pub fn available() -> bool {
    binary_exists("tesseract")
}

pub fn engine_name() -> &'static str {
    ENGINE_NAME
}

fn binary_exists(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(bin).is_file()))
        .unwrap_or(false)
}

/// True when the image is predominantly dark — light-on-dark UI text
/// (dark-mode screenshots) is tesseract's known weak spot, so these get
/// inverted to black-on-white before OCR. Pure over raw luma bytes so it
/// unit-tests without a real image file.
fn is_predominantly_dark(luma: &[u8]) -> bool {
    if luma.is_empty() {
        return false;
    }
    let sum: u64 = luma.iter().map(|&p| p as u64).sum();
    (sum / luma.len() as u64) < 128
}

pub fn extract_text(path: &Path) -> Option<String> {
    if !available() {
        return None;
    }

    let mut gray = image::open(path).ok()?.to_luma8();
    if is_predominantly_dark(gray.as_raw()) {
        for pixel in gray.pixels_mut() {
            pixel.0[0] = 255 - pixel.0[0];
        }
    }

    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("image");
    let tmp_path = std::env::temp_dir().join(format!("openray-ocr-{}-{file_name}.png", std::process::id()));
    gray.save(&tmp_path).ok()?;

    let output = Command::new("tesseract")
        .args([tmp_path.to_str()?, "stdout", "-l", "eng"])
        .stderr(std::process::Stdio::null())
        .output();

    let _ = std::fs::remove_file(&tmp_path);

    let output = output.ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_predominantly_dark_distinguishes_light_and_dark_fixtures() {
        assert!(!is_predominantly_dark(&[240, 245, 250, 235]));
        assert!(is_predominantly_dark(&[10, 20, 15, 5]));
    }

    #[test]
    fn is_predominantly_dark_is_false_for_empty_input() {
        assert!(!is_predominantly_dark(&[]));
    }
}
