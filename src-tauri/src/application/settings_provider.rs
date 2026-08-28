use tauri::AppHandle;

use crate::domain::command::{Command, CommandKind};
use crate::domain::ports::CommandProvider;
use crate::infrastructure::window;

pub const OPEN_SETTINGS_COMMAND_ID: &str = "builtin.open-settings";

pub struct SettingsCommandProvider {
    app: AppHandle,
}

impl SettingsCommandProvider {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl CommandProvider for SettingsCommandProvider {
    fn commands(&self) -> Vec<Command> {
        vec![Command {
            id: OPEN_SETTINGS_COMMAND_ID.into(),
            title: "OpenRay Settings".into(),
            subtitle: Some("Built-in Command".into()),
            icon: Some("settings".into()),
            kind: CommandKind::Builtin,
            keywords: vec!["settings".into(), "preferences".into(), "config".into()],
            arguments: Vec::new(),
        }]
    }

    fn execute(&self, _command_id: &str) -> Result<(), String> {
        window::open_settings_window(&self.app).map_err(|e| e.to_string())
    }
}
