-- An extension opts into Import/Export by declaring an `export` block in
-- its manifest. Persisted here as the manifest's raw JSON so the Settings
-- pane can list a checkbox for the extension without starting it — see
-- `infrastructure::extension_host::protocol::ExportDeclaration`. NULL for
-- every extension that declares nothing, which is the default.
ALTER TABLE extensions ADD COLUMN export_json TEXT;
