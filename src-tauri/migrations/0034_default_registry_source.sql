-- Ships the OpenRay Extensions registry as a source every install starts
-- with, so the Store has something in it before the user has configured
-- anything.
--
-- A migration rather than app-start logic, because "run exactly once per
-- database" is precisely the semantics wanted here. Seeding on every launch
-- would resurrect the row for anyone who deliberately removed it, and
-- removing a registry has to stay a decision the app respects — it is a
-- trust decision, and archives from it install automatically once trusted.
--
-- `INSERT OR IGNORE` covers the one case that would otherwise be a hard
-- error: a user who already added this URL by hand before upgrading. The
-- URL carries its trailing slash to match `normalize_url`, since
-- `source_url` equality is what separates a same-source update (silent)
-- from a cross-source replacement (confirmed) — an unnormalized spelling
-- here would become a second row the moment the registry was re-added.
--
-- `added_at = 0` sorts it first in `list()`, which orders by `added_at`.
INSERT OR IGNORE INTO registry_sources (url, name, enabled, auto_update, added_at)
VALUES ('https://tuanpham-dev.github.io/openray-extensions/', 'OpenRay Extensions', 1, 1, 0);
