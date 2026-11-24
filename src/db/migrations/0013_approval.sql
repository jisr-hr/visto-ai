alter table visto_ai.review_runs add column approved boolean not null default false;
alter table visto_ai.review_runs add column approval_code text;
alter table visto_ai.review_runs add column dismissed_at timestamptz;
alter table visto_ai.review_runs add column dismissed_by text;
alter table visto_ai.review_runs add column dismiss_failure text;
alter table visto_ai.review_runs add column stood_at_merge timestamptz;
create index review_runs_standing on visto_ai.review_runs (service, owner, repo, number) where approved and dismissed_at is null;
