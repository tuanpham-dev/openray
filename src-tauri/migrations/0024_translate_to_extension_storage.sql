-- T22: migrate existing custom translate commands and translate history
-- into extension_storage under the "translate" extension id, so root
-- search/the Translate view read them via the new translate extension
-- instead of the native TranslateProvider (deleted this same task).
--
-- Two distinct key prefixes share one extension id's storage: "pair:{id}"
-- for a custom command (mirrors its existing string id exactly, same as
-- quicklinks/snippets/window-management's own migrations), "history:{id}"
-- for a history entry (its id is an INTEGER AUTOINCREMENT, so CAST to TEXT
-- first — extension_storage.key is TEXT, same reasoning as any other
-- migration here, just with an explicit cast since this is the first
-- source table T15/T16/T18 didn't already have a natural string key).
--
-- `translate_commands`/`translate_history` are deliberately left in place
-- for one release — same dual-write rationale as every prior wave (see
-- SNAPSHOT_VERSION's doc comment in application/sync/snapshot.rs).
--
-- json_quote(printf('%s', json_object(...))) — see T15/T16/T18's
-- migrations for why this shape (not json_object(...) alone) is required
-- to match extension_storage's JSON-string encoding contract.
INSERT OR IGNORE INTO extension_storage (extension_id, key, value)
SELECT 'translate', 'pair:' || id, json_quote(printf('%s', json_object('id', id, 'title', title, 'sourceLang', source_lang, 'targetLang', target_lang, 'createdAt', created_at)))
FROM translate_commands;

INSERT OR IGNORE INTO extension_storage (extension_id, key, value)
SELECT 'translate', 'history:' || CAST(id AS TEXT), json_quote(printf('%s', json_object('id', CAST(id AS TEXT), 'sourceText', source_text, 'translatedText', translated_text, 'detectedLang', detected_lang, 'targetLang', target_lang, 'createdAt', created_at)))
FROM translate_history;
