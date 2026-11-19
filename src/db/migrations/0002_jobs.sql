create table visto_ai.jobs (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  reason text not null,
  head_sha text not null,
  status text not null,
  outcome text,
  run_at timestamptz not null,
  starts integer not null,
  created_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  delivery text
);
create unique index jobs_one_pending on visto_ai.jobs (service, owner, repo, number) where status = 'pending';
create index jobs_due on visto_ai.jobs (run_at) where status = 'pending';

create table visto_ai.heartbeat (
  only_row boolean primary key default true check (only_row),
  alive_at timestamptz not null
);

create table visto_ai.review_runs (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  job integer,
  trigger text not null,
  mode text not null,
  dry_run boolean not null,
  head_sha text not null,
  base_sha text,
  outcome text not null,
  failure_stage text, failure_code text,
  needs_human boolean not null,
  highest_score integer not null,
  body text not null,
  comments jsonb not null,
  result jsonb not null,
  calls integer not null, input_tokens integer not null, output_tokens integer not null, cached_tokens integer not null,
  cost double precision not null,
  started_at timestamptz not null,
  finished_at timestamptz not null
);
create index review_runs_pull_request on visto_ai.review_runs (service, owner, repo, number);
create index review_runs_started on visto_ai.review_runs (started_at);
