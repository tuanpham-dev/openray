#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "linux")]
pub mod linux_focus;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub mod macos_accessibility;
#[cfg(target_os = "macos")]
pub mod macos_panel;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub mod windows_focus;

pub mod background_priority;
pub mod clipboard_multi;
pub mod clipboard_sensitivity;
pub mod drop_at_cursor;
pub mod menu_bar;
pub mod ocr;
pub mod window_list;
pub mod window_manage;

#[cfg(target_os = "linux")]
pub use linux::LinuxAppScanner as PlatformAppScanner;
#[cfg(target_os = "macos")]
pub use macos::MacosAppScanner as PlatformAppScanner;
#[cfg(target_os = "windows")]
pub use windows::WindowsAppScanner as PlatformAppScanner;
