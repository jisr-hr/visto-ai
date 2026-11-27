create table visto_ai.alerts (
  id integer generated always as identity primary key,
  code text not null,
  key text not null,
  details jsonb not null,
  raised_at timestamptz not null,
  cleared_at timestamptz
);
create index alerts_raised on visto_ai.alerts (raised_at);
create index alerts_open on visto_ai.alerts (code, key) where cleared_at is null;
create table visto_ai.dependency_health (
  kind text not null check (kind in ('model', 'scorer', 'memory', 'extension', 'mcp', 'app')),
  name text not null,
  part text not null,
  status text not null check (status in ('ok', 'failing')),
  code text,
  missing jsonb,
  since timestamptz not null,
  seen_at timestamptz not null,
  primary key (kind, name, part)
);
alter table visto_ai.memory_records add column switched_at timestamptz;
alter table visto_ai.memory_records add column switched_by text;
