-- Run in the Supabase SQL editor. The server uses its service-role key only
-- from the PC process; never put that key in either APK or a browser build.
create table if not exists public.fleet_devices (
  device_id text primary key,
  display_name text not null,
  device_role text not null check (device_role in ('master', 'tracker')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.fleet_device_state (
  device_id text primary key references public.fleet_devices(device_id) on delete cascade,
  online boolean not null default false,
  last_seen_at timestamptz,
  last_telemetry jsonb,
  updated_at timestamptz not null
);

create table if not exists public.fleet_commands (
  id text primary key,
  device_id text not null references public.fleet_devices(device_id),
  command text not null,
  issued_by text not null,
  status text not null check (status in ('pending', 'sent', 'acked', 'failed')),
  created_at timestamptz not null,
  sent_at timestamptz,
  completed_at timestamptz,
  detail text
);

create index if not exists fleet_commands_device_created_idx
  on public.fleet_commands (device_id, created_at desc);

alter table public.fleet_devices enable row level security;
alter table public.fleet_device_state enable row level security;
alter table public.fleet_commands enable row level security;

-- Deliberately no anon/authenticated policies. The private broker writes with
-- the service-role key; any hosted dashboard should read through an API that
-- enforces its own admin authentication and device-level authorization.
