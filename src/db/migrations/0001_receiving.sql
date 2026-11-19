create table visto_ai.deliveries (
  id text primary key,
  name text not null,
  action text,
  outcome text not null,
  reason text,
  received_at timestamptz not null default now()
);

create table visto_ai.pull_requests (
  service text not null, owner text not null, repo text not null, number integer not null,
  author text not null, author_is_bot boolean not null,
  base_branch text not null, head_branch text not null, head_sha text not null,
  draft boolean not null,
  state text not null,
  merged_at timestamptz, closed_at timestamptz, merge_commit text,
  installation text,
  updated_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  primary key (service, owner, repo, number)
);

create table visto_ai.human_activity (
  id integer generated always as identity primary key,
  service text not null, owner text not null, repo text not null, number integer not null,
  kind text not null,
  source_id text not null,
  author text not null,
  association text,
  state text,
  body text not null,
  path text, side text, line integer, start_line integer, file_level boolean,
  commit text, reply_to text, thread text,
  at timestamptz not null,
  delivery text,
  unique (service, kind, source_id)
);
create index human_activity_pull_request on visto_ai.human_activity (service, owner, repo, number);
