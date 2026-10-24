-- A reviewer's manual override: "this document IS the client", regardless of
-- how badly its printed name reads. clusterPeople (lib/proposal/people.ts)
-- checks this flag before attempting any name match, and keeps honouring it
-- on every future re-cluster — a plain person_key write would be silently
-- recomputed away the next time anything re-clusters, since that function
-- never trusts a document's existing person_key as input.
alter table documents add column if not exists person_client_confirmed boolean not null default false;
