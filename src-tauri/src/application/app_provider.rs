use crate::domain::command::{Command, CommandKind};
use crate::domain::ports::{AppScanner, CommandProvider};

pub struct AppCommandProvider {
    scanner: Box<dyn AppScanner>,
}

impl AppCommandProvider {
    pub fn new(scanner: Box<dyn AppScanner>) -> Self {
        Self { scanner }
    }
}

impl CommandProvider for AppCommandProvider {
    fn commands(&self) -> Vec<Command> {
        self.scanner
            .scan()
            .into_iter()
            .map(|app| Command {
                id: app.id,
                title: app.name,
                subtitle: Some("Application".into()),
                icon: app.icon,
                kind: CommandKind::App,
                keywords: vec![],
                requires_argument: false,
            })
            .collect()
    }

    fn execute(&self, command_id: &str) -> Result<(), String> {
        self.scanner.launch(command_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeScanner;

    impl AppScanner for FakeScanner {
        fn scan(&self) -> Vec<crate::domain::ports::InstalledApp> {
            vec![crate::domain::ports::InstalledApp {
                id: "firefox.desktop".into(),
                name: "Firefox".into(),
                icon: None,
            }]
        }

        fn launch(&self, _app_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn exposes_scanned_apps_as_commands() {
        let provider = AppCommandProvider::new(Box::new(FakeScanner));
        let commands = provider.commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].title, "Firefox");
        assert_eq!(commands[0].kind, CommandKind::App);
    }

    #[test]
    fn execute_delegates_to_scanner_launch() {
        let provider = AppCommandProvider::new(Box::new(FakeScanner));
        assert!(provider.execute("firefox.desktop").is_ok());
    }
}
