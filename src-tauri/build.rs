fn main() {
  // Compile the native Vision OCR shim (vision_ocr.m) into the binary and
  // link the frameworks it needs — see ocr/macos.rs for why this replaced
  // the previous objc2-based backend (VNImageRequestHandler's own file-URL
  // loading path was found hanging on real hardware; this decodes through
  // ImageIO into a CGImage instead).
  #[cfg(target_os = "macos")]
  {
    println!("cargo:rerun-if-changed=vision_ocr.m");
    cc::Build::new().file("vision_ocr.m").flag("-fobjc-arc").compile("openray_vision_ocr");
    for framework in ["Foundation", "Vision", "CoreGraphics", "ImageIO"] {
      println!("cargo:rustc-link-lib=framework={framework}");
    }
  }

  tauri_build::build()
}
