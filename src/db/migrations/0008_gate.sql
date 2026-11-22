alter table visto_ai.jobs add column kind text not null default 'review';
drop index visto_ai.jobs_one_pending;
create unique index jobs_one_pending on visto_ai.jobs (service, owner, repo, number, kind) where status = 'pending';

create table visto_ai.gate_evaluations (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  head_sha text not null,
  at timestamptz not null,
  mode text not null,
  state text not null,
  code text,
  run integer,
  blocking integer not null, cleared_by_review integer not null, cleared_by_reply integer not null,
  silent_resolves integer not null, unknown_threads integer not null,
  findings integer not null, not_reviewed integer not null, without_thread integer not null, refused_inline integer not null
);
create index gate_evaluations_pull_request on visto_ai.gate_evaluations (service, owner, repo, number, id);

create table visto_ai.gate_overrides (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  head_sha text not null,
  actor text not null,
  reason text not null,
  comment_id text not null,
  at timestamptz not null,
  unique (service, comment_id)
);
create index gate_overrides_head on visto_ai.gate_overrides (service, owner, repo, number, head_sha);
