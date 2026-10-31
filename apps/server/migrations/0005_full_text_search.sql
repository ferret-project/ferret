-- Full-text search (FTS5), kept in sync by src/lib/fulltext.ts. One row per item (its fields and
-- location path) plus one per attachment (file name, description and transcribed text).
-- Words, with stemming: "drills" finds "drill".
CREATE VIRTUAL TABLE `item_search` USING fts5(
	item_id UNINDEXED, household_id UNINDEXED, attachment_id UNINDEXED, filename UNINDEXED,
	title, body,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Substrings, for serial and model numbers: "1234567" finds "W1234567".
CREATE VIRTUAL TABLE `item_search_trigram` USING fts5(
	item_id UNINDEXED, household_id UNINDEXED, attachment_id UNINDEXED, filename UNINDEXED,
	body,
	tokenize = 'trigram'
);
