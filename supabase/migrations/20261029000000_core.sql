-- 2A Group Corp petition platform: core schema.
--
-- The Node server (service role) does every write, so presets, staff-only fields and
-- USCIS checks are enforced in one place. Row Level Security still guards every table
-- so the web app, a future mobile app and Realtime can read only what each person may see:
--   * clients see their own case documents and non-internal messages, never staff data;
--   * staff see every case except restricted ones (VAWA, T-Visa, asylum), which only the
--     assigned team, attorneys and admins can open (8 U.S.C. 1367, 8 CFR 208.6).
-- Changes to cases, documents, messages and packages are sent to n8n (see automation).

create extension if not exists pg_net with schema extensions;

create type public.app_role as enum ('client', 'staff', 'attorney', 'admin');
create type public.doc_status as enum ('pending', 'accepted', 'rejected');
create type public.package_status as enum ('draft', 'approved', 'returned');

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text,
  phone text,
  role public.app_role not null default 'client',
  preferred_language text not null default 'en',
  created_at timestamptz not null default now()
);

-- The role comes from app_metadata, which only the server can set. Sign-up is disabled in
-- config.toml: people join by invitation only.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce((new.raw_app_meta_data ->> 'role')::public.app_role, 'client')
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

create sequence public.case_number_seq;

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  case_number text not null unique
    default ('2A-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.case_number_seq')::text, 5, '0')),
  client_id uuid references public.profiles (id) on delete set null,
  client_name text not null,
  client_email text,
  preset text not null,
  confidential boolean not null default false,
  stage text not null default 'Intake',
  answers jsonb not null default '{}'::jsonb,
  receipt_number text,
  -- Readiness is recalculated by the server after every change and by the daily job.
  ready boolean not null default false,
  missing_documents int not null default 0,
  missing_answers int not null default 0,
  readiness jsonb,
  content_changed_at timestamptz not null default now(),
  last_client_activity_at timestamptz,
  last_reminder_at timestamptz,
  is_demo boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cases_client_idx on public.cases (client_id);
create index cases_stage_idx on public.cases (stage);

create table public.case_team (
  case_id uuid not null references public.cases (id) on delete cascade,
  staff_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'staff',
  added_at timestamptz not null default now(),
  primary key (case_id, staff_id)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  checklist_id text not null,
  original_name text not null,
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  status public.doc_status not null default 'pending',
  note text,
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_role text not null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index documents_case_idx on public.documents (case_id, checklist_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  sender_role text not null check (sender_role in ('client', 'staff', 'automation')),
  body text not null check (length(body) between 1 and 4000),
  internal boolean not null default false,
  read_by_staff_at timestamptz,
  read_by_client_at timestamptz,
  created_at timestamptz not null default now(),
  check (not (internal and sender_role = 'client'))
);
create index messages_case_idx on public.messages (case_id, created_at);

create table public.packages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  version int not null,
  status public.package_status not null default 'draft',
  draft_path text not null,
  final_path text,
  page_count int,
  final_page_count int,
  exhibits int,
  sections jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  forced boolean not null default false,
  built_by text not null,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_by_name text,
  approved_at timestamptz,
  return_reason text,
  created_at timestamptz not null default now(),
  unique (case_id, version)
);

-- Dates computed from the USCIS timing rules (I-751 window, asylum one-year deadline...).
create table public.deadlines (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete cascade,
  kind text not null,
  title text not null,
  due_date date not null,
  severity text not null default 'normal' check (severity in ('normal', 'high')),
  done boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (case_id, kind)
);
create index deadlines_due_idx on public.deadlines (due_date) where not done;

-- Append-only: every view, edit, upload, build, approval and download.
create table public.audit_log (
  id bigint generated always as identity primary key,
  case_id uuid,
  actor_id uuid,
  actor_role text not null,
  actor_name text,
  action text not null,
  detail text not null default '',
  at timestamptz not null default now()
);
create index audit_case_idx on public.audit_log (case_id, at desc);

create function public.audit_log_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;

create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger cases_touch before update on public.cases
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers (security definer so policies can call them without recursion)
-- ---------------------------------------------------------------------------

create function public.my_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() in ('staff', 'attorney', 'admin'), false)
$$;

-- Staff may open a case unless it is restricted and they are not on its team.
create function public.staff_can_access(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() and exists (
    select 1 from public.cases c
    where c.id = cid
      and (not c.confidential
           or public.my_role() in ('attorney', 'admin')
           or exists (select 1 from public.case_team t where t.case_id = c.id and t.staff_id = auth.uid()))
  )
$$;

create function public.is_case_client(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cases c where c.id = cid and c.client_id = auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security. No insert/update/delete policies: writes go through the server.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.cases enable row level security;
alter table public.case_team enable row level security;
alter table public.documents enable row level security;
alter table public.messages enable row level security;
alter table public.packages enable row level security;
alter table public.deadlines enable row level security;
alter table public.audit_log enable row level security;

create policy "own profile" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());

-- Clients read their case through the server, which strips staff-only answers.
create policy "staff read cases" on public.cases for select to authenticated
  using (public.staff_can_access(id));

create policy "staff read team" on public.case_team for select to authenticated
  using (public.staff_can_access(case_id));

create policy "read documents" on public.documents for select to authenticated
  using (public.staff_can_access(case_id) or public.is_case_client(case_id));

create policy "read messages" on public.messages for select to authenticated
  using (public.staff_can_access(case_id) or (public.is_case_client(case_id) and not internal));

create policy "staff read packages" on public.packages for select to authenticated
  using (public.staff_can_access(case_id));

create policy "staff read deadlines" on public.deadlines for select to authenticated
  using (public.staff_can_access(case_id));

create policy "staff read audit" on public.audit_log for select to authenticated
  using (case_id is not null and public.staff_can_access(case_id));

revoke insert, update, delete on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

-- Live updates for chat, uploads, reviews and package status.
alter publication supabase_realtime add table public.messages, public.documents, public.packages, public.cases;

-- ---------------------------------------------------------------------------
-- File storage: private buckets, path = <case id>/<file>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('case-documents', 'case-documents', false, 26214400, array['application/pdf', 'image/jpeg', 'image/png']),
  ('packages', 'packages', false, 209715200, array['application/pdf']);

create policy "case documents read" on storage.objects for select to authenticated
  using (bucket_id = 'case-documents'
         and (public.staff_can_access(((storage.foldername(name))[1])::uuid)
              or public.is_case_client(((storage.foldername(name))[1])::uuid)));

create policy "packages read" on storage.objects for select to authenticated
  using (bucket_id = 'packages' and public.staff_can_access(((storage.foldername(name))[1])::uuid));
