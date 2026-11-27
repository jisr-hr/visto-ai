create table visto_ai.generated_secrets (name text primary key check (name = 'audit_key'), value text not null check (length(value) >= 32), created_at timestamptz not null);
