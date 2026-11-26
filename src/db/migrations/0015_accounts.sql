delete from visto_ai.ui_sessions;
create table visto_ai.ui_accounts (
  id integer generated always as identity primary key,
  kind text not null check (kind in ('password', 'github')),
  name text not null,
  role text not null check (role in ('admin', 'viewer')),
  password_hash text,
  one_time_until timestamptz,
  failed_tries integer not null default 0,
  wait_until timestamptz,
  made_at timestamptz not null,
  made_by_kind text not null check (made_by_kind in ('password', 'github', 'command', 'sign_in')),
  made_by_name text,
  last_sign_in_at timestamptz,
  check ((kind = 'password') = (password_hash is not null)),
  check (kind = 'password' or (one_time_until is null and wait_until is null and failed_tries = 0))
);
create unique index ui_accounts_name on visto_ai.ui_accounts (kind, lower(name));
create table visto_ai.ui_account_changes (
  id integer generated always as identity primary key,
  at timestamptz not null,
  by_kind text not null check (by_kind in ('password', 'github', 'command', 'sign_in')),
  by_name text,
  change text not null check (change in ('made', 'role', 'reset', 'removed', 'password_changed')),
  account_kind text not null check (account_kind in ('password', 'github')),
  account_name text not null,
  role text check (role in ('admin', 'viewer'))
);
create index ui_account_changes_at on visto_ai.ui_account_changes (at);
alter table visto_ai.ui_sessions add column account_id integer not null references visto_ai.ui_accounts (id) on delete cascade;
create index ui_sessions_account on visto_ai.ui_sessions (account_id);
