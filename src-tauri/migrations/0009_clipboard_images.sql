-- Clipboard images are stored as PNG files on disk with only their path
-- here: keeping multi-megabyte blobs in SQLite would bloat the database
-- and slow every history query, and a path can be served directly to the
-- webview through the asset protocol.
ALTER TABLE clipboard_history ADD COLUMN image_path TEXT;
ALTER TABLE clipboard_history ADD COLUMN image_width INTEGER;
ALTER TABLE clipboard_history ADD COLUMN image_height INTEGER;
