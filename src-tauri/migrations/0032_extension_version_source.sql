-- Where an installed extension came from, and which version of it is here.
--
-- `version` is the manifest's own `version` (synthesized date-based for
-- extensions packed out of the raycast/extensions monorepo, which mostly
-- declare none). `source_url` is the registry base URL an extension was
-- installed from, and NULL for everything that didn't come from one —
-- builtins, dev folders, a local path, a raycast slug, a hand-picked .orx.
--
-- Together they are what makes an update check possible at all: "this id,
-- at this version, from this catalog" is the only way to know a newer build
-- is available without asking every registry about every extension.
ALTER TABLE extensions ADD COLUMN version TEXT;
ALTER TABLE extensions ADD COLUMN source_url TEXT;
