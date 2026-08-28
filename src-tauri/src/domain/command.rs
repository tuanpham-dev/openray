use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandKind {
    App,
    Builtin,
    ExtensionCommand,
}

/// One choice for a `dropdown`-type argument.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandArgumentOption {
    pub title: String,
    pub value: String,
}

/// An argument a command collects before it runs.
///
/// Carried all the way to the palette because that is where the fields are
/// filled in: Raycast renders them inline in root search, so the frontend
/// needs their names, types, and whether each is required — not merely
/// whether the command wants an argument at all.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandArgument {
    pub name: String,
    /// `text`, `password`, or `dropdown`.
    #[serde(rename = "type")]
    pub argument_type: String,
    pub placeholder: Option<String>,
    pub required: bool,
    pub data: Option<Vec<CommandArgumentOption>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub icon: Option<String>,
    pub kind: CommandKind,
    pub keywords: Vec<String>,
    /// Empty for the overwhelming majority of commands. A non-empty list
    /// makes the palette show these fields inline before running.
    pub arguments: Vec<CommandArgument>,
}

impl Command {
    /// Whether this command cannot run without input — the gate for a
    /// headless launch (a global hotkey). An *optional* argument is not a
    /// blocker: the command runs fine with it empty.
    pub fn requires_input(&self) -> bool {
        self.arguments.iter().any(|argument| argument.required)
    }
}
