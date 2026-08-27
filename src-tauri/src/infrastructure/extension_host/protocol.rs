// Consumed by the sidecar process/RPC client landing in T18-T21; only the
// round-trip fixtures exercise these types until then.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(i64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: RpcId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: RpcId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// Order matters: each variant is tried in turn and the first structural
/// match wins. `Request` requires both `id` and `method`, `Response`
/// requires `id` without `method`, `Notification` requires `method`
/// without `id` — `deny_unknown_fields` on each keeps them from
/// cross-matching a message meant for one of the others.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcMessage {
    Request(RpcRequest),
    Response(RpcResponse),
    Notification(RpcNotification),
}

/// A 4-byte big-endian length prefix followed by that many bytes of UTF-8
/// JSON. Used for both directions of the Rust <-> Node sidecar stdio pipe.
pub fn encode_frame(message: &RpcMessage) -> serde_json::Result<Vec<u8>> {
    let json = serde_json::to_vec(message)?;
    let mut frame = Vec::with_capacity(4 + json.len());
    frame.extend_from_slice(&(json.len() as u32).to_be_bytes());
    frame.extend_from_slice(&json);
    Ok(frame)
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> serde_json::Result<Vec<RpcMessage>> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes(self.buffer[0..4].try_into().unwrap()) as usize;
            if self.buffer.len() < 4 + len {
                break;
            }
            let message: RpcMessage = serde_json::from_slice(&self.buffer[4..4 + len])?;
            messages.push(message);
            self.buffer.drain(0..4 + len);
        }
        Ok(messages)
    }
}

pub type NodeId = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiNode {
    pub id: NodeId,
    #[serde(rename = "type")]
    pub node_type: String,
    pub props: HashMap<String, Value>,
    pub children: Vec<NodeId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiTreeSnapshot {
    #[serde(rename = "rootId")]
    pub root_id: NodeId,
    pub nodes: HashMap<NodeId, UiNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum UiDiffOp {
    #[serde(rename = "insert")]
    Insert {
        node: UiNode,
        #[serde(rename = "parentId")]
        parent_id: NodeId,
        index: usize,
    },
    #[serde(rename = "remove")]
    Remove { id: NodeId },
    #[serde(rename = "reorder")]
    Reorder {
        #[serde(rename = "parentId")]
        parent_id: NodeId,
        #[serde(rename = "childIds")]
        child_ids: Vec<NodeId>,
    },
    #[serde(rename = "updateProps")]
    UpdateProps {
        id: NodeId,
        props: HashMap<String, Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum UiTreeCommit {
    #[serde(rename = "snapshot")]
    Snapshot { snapshot: UiTreeSnapshot },
    #[serde(rename = "diff")]
    Diff { ops: Vec<UiDiffOp> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandMode {
    View,
    NoView,
    MenuBar,
    /// T14: contributes dynamic rows to root search instead of being a
    /// row itself. Its command module exports a plain listing function
    /// (no React/reconciler involvement) plus a named `execute` — see
    /// `application::root_commands`'s module doc comment for the full
    /// contract.
    RootProvider,
}

/// One row a `root-provider` command contributes to search — the shape
/// its listing function's `Promise<RootCommand[]>` resolves to, pushed to
/// Rust via the `extension.rootCommands` notification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootCommand {
    /// Opaque and extension-defined — becomes `ext:{extensionId}:{id}`,
    /// reusing the same id shape (and `parse_extension_command_id`) a
    /// static manifest command already uses. Must stay stable across
    /// refreshes for the same logical row: usage/frecency and
    /// `command_settings` (alias/hotkey/enabled) key on it directly.
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub requires_argument: bool,
    /// Routes activation through the palette's confirm surface instead of
    /// running headless off a hotkey — the dynamic-row equivalent of
    /// `system_commands::CONFIRM_COMMAND_IDS`.
    #[serde(default)]
    pub needs_confirm: bool,
    /// Routes activation through the palette (view) instead of running
    /// headless — the dynamic-row equivalent of `VIEW_BUILTIN_IDS`.
    #[serde(default)]
    pub opens_view: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionCommandManifest {
    pub name: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub mode: CommandMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Vec<ExtensionPreference>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<ExtensionArgument>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgumentType {
    Text,
    Password,
    Dropdown,
}

/// Raycast's `arguments[]` manifest shape. Only the *first* declared
/// argument reaches the launch-time argument bar today — the native
/// argument-bar mechanism this reuses (`quicklink-argument`/
/// `run_command_with_argument`) only ever carries one string value end to
/// end. A command declaring more than one argument still gets
/// `requiresArgument: true` off the first, but only that one is
/// collected; the rest are absent from `LaunchProps.arguments`. Revisit
/// if a real multi-argument extension needs it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionArgument {
    pub name: String,
    #[serde(rename = "type")]
    pub argument_type: ArgumentType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<PreferenceOption>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreferenceType {
    Textfield,
    Password,
    Checkbox,
    Dropdown,
    AppPicker,
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreferenceOption {
    pub title: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionPreference {
    pub name: String,
    #[serde(rename = "type")]
    pub preference_type: PreferenceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<PreferenceOption>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub name: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    pub commands: Vec<ExtensionCommandManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Vec<ExtensionPreference>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/../packages/protocol/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"))
    }

    fn round_trip<T>(json: &str)
    where
        T: for<'de> Deserialize<'de> + Serialize + PartialEq + std::fmt::Debug,
    {
        let value: T = serde_json::from_str(json).expect("deserialize");
        let serialized = serde_json::to_string(&value).expect("serialize");
        let value2: T = serde_json::from_str(&serialized).expect("re-deserialize");
        assert_eq!(value, value2);
    }

    #[test]
    fn round_trips_request() {
        let json = fixture("request.json");
        round_trip::<RpcMessage>(&json);
        match serde_json::from_str::<RpcMessage>(&json).unwrap() {
            RpcMessage::Request(_) => {}
            other => panic!("expected Request, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_notification() {
        let json = fixture("notification.json");
        round_trip::<RpcMessage>(&json);
        match serde_json::from_str::<RpcMessage>(&json).unwrap() {
            RpcMessage::Notification(_) => {}
            other => panic!("expected Notification, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_response_ok() {
        let json = fixture("response-ok.json");
        round_trip::<RpcMessage>(&json);
        match serde_json::from_str::<RpcMessage>(&json).unwrap() {
            RpcMessage::Response(r) => assert!(r.error.is_none()),
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_response_error() {
        let json = fixture("response-error.json");
        round_trip::<RpcMessage>(&json);
        match serde_json::from_str::<RpcMessage>(&json).unwrap() {
            RpcMessage::Response(r) => assert!(r.result.is_none() && r.error.is_some()),
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn round_trips_ui_snapshot() {
        round_trip::<UiTreeCommit>(&fixture("ui-snapshot.json"));
    }

    #[test]
    fn round_trips_ui_diff() {
        round_trip::<UiTreeCommit>(&fixture("ui-diff.json"));
    }

    #[test]
    fn round_trips_manifest() {
        let json = fixture("manifest.json");
        round_trip::<ExtensionManifest>(&json);
        let manifest: ExtensionManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest.commands.len(), 2);
    }

    #[test]
    fn frame_round_trip_single_and_split() {
        let message: RpcMessage = serde_json::from_str(&fixture("request.json")).unwrap();
        let frame = encode_frame(&message).unwrap();

        let mut decoder = FrameDecoder::new();
        let decoded = decoder.push(&frame).unwrap();
        assert_eq!(decoded, vec![message.clone()]);

        let mut split_decoder = FrameDecoder::new();
        let mid = frame.len() / 2;
        assert!(split_decoder.push(&frame[..mid]).unwrap().is_empty());
        let decoded_split = split_decoder.push(&frame[mid..]).unwrap();
        assert_eq!(decoded_split, vec![message]);
    }

    #[test]
    fn frame_decodes_multiple_queued_messages() {
        let a: RpcMessage = serde_json::from_str(&fixture("request.json")).unwrap();
        let b: RpcMessage = serde_json::from_str(&fixture("notification.json")).unwrap();
        let mut combined = encode_frame(&a).unwrap();
        combined.extend(encode_frame(&b).unwrap());

        let mut decoder = FrameDecoder::new();
        let decoded = decoder.push(&combined).unwrap();
        assert_eq!(decoded, vec![a, b]);
    }
}
