create table visto_ai.memory_records (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null,
  kind text not null check (kind in ('human_signal', 'revert', 'lesson')),
  source_ref text not null,
  status text not null default 'active' check (status in ('active', 'disabled', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  number integer not null,
  path text,
  directory text,
  category text,
  reason text,
  missed boolean not null default false,
  excerpt text not null default '',
  comment text,
  unique (service, owner, repo, kind, source_ref)
);
create index memory_records_live on visto_ai.memory_records (service, owner, repo, kind, created_at desc, id desc) where status = 'active';

create table visto_ai.learning (
  work text primary key,
  since timestamptz not null,
  ran_at timestamptz,
  examined integer not null default 0,
  added integer not null default 0,
  retired integer not null default 0,
  failed integer not null default 0
);

alter table visto_ai.human_activity add column learned_at timestamptz;
create index human_activity_unlearned on visto_ai.human_activity (service, owner, repo, number) where kind = 'inline_comment' and learned_at is null;
alter table visto_ai.pull_requests add column learned_at timestamptz;
alter table visto_ai.pull_requests add column learn_attempts integer not null default 0;
