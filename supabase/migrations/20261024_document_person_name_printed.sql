-- The name as it appeared on the page, kept alongside the name we resolved it
-- to. Clustering replaces person_name with the person's agreed label so that
-- exports and grouping speak about one person consistently; without this
-- column the original spelling is destroyed, and a reviewer can no longer see
-- WHY three differently-spelled pages were treated as one person.
--
-- Semicolon-separated where a document is itself a merge of several, each
-- printed differently.
alter table documents add column if not exists person_name_printed text;
