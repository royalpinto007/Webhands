-- Webhands run log. Runs in the shared AgentPostmortem Supabase project.

create table if not exists wh_runs (
  id          uuid primary key default gen_random_uuid(),
  target_url  text not null,
  mode        text not null,        -- live | dry
  ok          boolean not null,
  confirmed   boolean not null default false,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists wh_runs_created_idx on wh_runs(created_at desc);

alter table wh_runs enable row level security;
