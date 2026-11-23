alter table visto_ai.review_runs add column notified_at timestamptz;

create table visto_ai.review_feedback (
  id integer generated always as identity primary key,
  run integer not null,
  service text not null, owner text not null, repo text not null, number integer not null,
  login text not null,
  vote text not null check (vote in ('up', 'down')),
  reason text,
  extension text not null,
  at timestamptz not null,
  unique (run, login)
);
