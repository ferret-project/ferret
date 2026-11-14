-- Full-text search over the files of properties, places and maintenance tasks (lib/fulltext.ts refreshFileSearch):
-- one row per file — its name, what the AI read in it (a photo's description, a document's text) and what it
-- belongs to. A thing's files are in item_search with the thing. Rebuilt on start if empty (ensureFullText).
CREATE VIRTUAL TABLE `file_search` USING fts5(
	attachment_id UNINDEXED, household_id UNINDEXED,
	title, body,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
