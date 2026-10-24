-- Other identifying clues for the same subject person_name already names, each
-- as printed — only ever set from something explicit on the page, never
-- inferred. Used alongside the name and date of birth to cluster people (see
-- lib/proposal/people.ts): gender and a derived birth year from person_age are
-- decisive — a conflict there splits two people the way a differing date of
-- birth already does — while patient_id and address only ever confirm an
-- already-plausible spelling match, never rescue an outright different name.
alter table documents add column if not exists person_gender text;
alter table documents add column if not exists person_age text;
alter table documents add column if not exists person_patient_id text;
alter table documents add column if not exists person_address text;
