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
                // The app's own description where the platform has one —
                // the frontend gives it a line of its own, since the
                // trailing "Application" label already says what the
                // generic fallback would only repeat.
                subtitle: Some(app.description.unwrap_or_else(|| "Application".into())),
                icon: app.icon,
                kind: CommandKind::App,
                keywords: vec![],
                arguments: Vec::new(),
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
                description: None,
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

    #[test]
    fn falls_back_to_the_generic_label_when_the_scanner_has_no_description() {
        let provider = AppCommandProvider::new(Box::new(FakeScanner));
        assert_eq!(provider.commands()[0].subtitle.as_deref(), Some("Application"));
    }

    #[test]
    fn carries_the_scanner_s_own_description_as_the_subtitle() {
        struct DescribedScanner;
        impl AppScanner for DescribedScanner {
            fn scan(&self) -> Vec<crate::domain::ports::InstalledApp> {
                vec![crate::domain::ports::InstalledApp {
                    id: "firefox.desktop".into(),
                    name: "Firefox".into(),
                    icon: None,
                    description: Some("Browse the World Wide Web".into()),
                }]
            }
            fn launch(&self, _app_id: &str) -> Result<(), String> {
                Ok(())
            }
        }

        let provider = AppCommandProvider::new(Box::new(DescribedScanner));
        assert_eq!(provider.commands()[0].subtitle.as_deref(), Some("Browse the World Wide Web"));
    }
}
