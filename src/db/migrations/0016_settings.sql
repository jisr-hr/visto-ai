create table visto_ai.settings (
  scope text not null,
  path text not null,
  value jsonb not null,
  set_by text not null check (set_by in ('config.yml', 'ui')),
  set_by_name text,
  set_at timestamptz not null,
  primary key (scope, path),
  check ((set_by = 'ui') = (set_by_name is not null))
);
create table visto_ai.settings_file (
  scope text not null,
  path text not null,
  value jsonb not null,
  primary key (scope, path)
);
create table visto_ai.setting_changes (
  id integer generated always as identity primary key,
  at timestamptz not null,
  by text not null check (by in ('config.yml', 'ui')),
  by_name text,
  scope text not null,
  path text not null,
  old_value jsonb,
  new_value jsonb,
  check ((by = 'ui') = (by_name is not null)),
  check (old_value is not null or new_value is not null)
);
