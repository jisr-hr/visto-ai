alter table visto_ai.jobs add column trigger text not null default 'automatic';
alter table visto_ai.jobs add column requested_by text;
alter table visto_ai.jobs add column comment_id text;
alter table visto_ai.jobs add column association text;
alter table visto_ai.jobs add column installation text;

alter table visto_ai.review_runs add column published boolean not null default false;
alter table visto_ai.review_runs add column review_id text;
alter table visto_ai.review_runs add column published_at timestamptz;
alter table visto_ai.review_runs add column inline_dropped boolean not null default false;
create index review_runs_published on visto_ai.review_runs (service, owner, repo, number) where published;

create table visto_ai.review_comments (
  id integer generated always as identity primary key,
  run integer not null,
  service text not null, owner text not null, repo text not null, number integer not null,
  comment_id text not null,
  path text not null, side text not null, line integer,
  severity text not null,
  quote text not null,
  unique (service, comment_id)
);
create index review_comments_pull_request on visto_ai.review_comments (service, owner, repo, number);
