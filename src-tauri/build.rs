fn main() {
  // Compile the native Vision OCR shim (vision_ocr.m) into the binary and
  // link the frameworks it needs — see ocr/macos.rs for why this replaced
  // the previous objc2-based backend (VNImageRequestHandler's own file-URL
  // loading path was found hanging on real hardware; this decodes through
  // ImageIO into a CGImage instead).
  //
  // Gate on the *target* OS via `CARGO_CFG_TARGET_OS`, not a host `#[cfg]`:
  // a build script runs on the host, so a host `#[cfg(target_os = "macos")]`
  // wrongly tries to compile this Objective-C shim when cross-compiling *from*
  // a Mac to Windows/Linux (e.g. the repo's own cross-compile checks run from
  // a macOS dev box), which fails since the target isn't macOS. The target-OS
  // env var is the correct signal and works from any host.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    println!("cargo:rerun-if-changed=vision_ocr.m");
    cc::Build::new().file("vision_ocr.m").flag("-fobjc-arc").compile("openray_vision_ocr");
    for framework in ["Foundation", "Vision", "CoreGraphics", "ImageIO"] {
      println!("cargo:rustc-link-lib=framework={framework}");
    }
  }

  tauri_build::build()
}
