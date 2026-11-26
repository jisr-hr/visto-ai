alter table visto_ai.pull_requests add column title text;
alter table visto_ai.jobs add column stage text;
alter table visto_ai.jobs add column stage_at timestamptz;
alter table visto_ai.jobs add column batch integer;
alter table visto_ai.jobs add column batches integer;
alter table visto_ai.jobs add column threads_due integer;
alter table visto_ai.jobs add column retry_code text;
create table visto_ai.ui_sessions (
  id_hash text primary key,
  login text not null,
  via text not null,
  created_at timestamptz not null,
  last_used_at timestamptz not null,
  expires_at timestamptz not null
);
create table visto_ai.ui_states (
  state_hash text primary key,
  verifier_hash text not null,
  expires_at timestamptz not null
);
create index ui_states_expires on visto_ai.ui_states (expires_at);
