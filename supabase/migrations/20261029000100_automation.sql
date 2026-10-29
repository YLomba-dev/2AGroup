-- Automation: every meaningful change is written to automation_events and posted to the
-- n8n "case-event" webhook. The event carries ids only; n8n calls the server (with the
-- automation key) for the details, so nothing confidential travels in the webhook body.

create table public.app_settings (
  key text primary key,
  value text not null
);
alter table public.app_settings enable row level security;

insert into public.app_settings (key, value) values
  ('n8n_event_url', 'http://host.docker.internal:5678/webhook/case-event');

create table public.automation_events (
  id bigint generated always as identity primary key,
  case_id uuid,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  request_id bigint,
  created_at timestamptz not null default now()
);
create index automation_events_case_idx on public.automation_events (case_id, created_at desc);
alter table public.automation_events enable row level security;

create function public.emit_event(p_case uuid, p_event text, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_id bigint;
  v_req bigint;
begin
  insert into public.automation_events (case_id, event, payload)
  values (p_case, p_event, p_payload)
  returning id into v_id;

  select value into v_url from public.app_settings where key = 'n8n_event_url';
  if v_url is null or v_url = '' then
    return;
  end if;

  -- pg_net sends after the transaction commits; a failed call never blocks the change.
  select net.http_post(
    url := v_url,
    body := jsonb_build_object('eventId', v_id, 'event', p_event, 'caseId', p_case) || p_payload,
    headers := '{"Content-Type": "application/json"}'::jsonb
  ) into v_req;
  update public.automation_events set request_id = v_req where id = v_id;
end $$;

revoke execute on function public.emit_event(uuid, text, jsonb) from public, anon, authenticated;

-- Cases: created, stage changed, became ready to build.
create function public.on_case_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.emit_event(new.id, 'case.created', jsonb_build_object('preset', new.preset));
    return new;
  end if;
  if new.stage is distinct from old.stage then
    perform public.emit_event(new.id, 'case.stage_changed', jsonb_build_object('from', old.stage, 'to', new.stage));
  end if;
  if new.ready and not old.ready then
    perform public.emit_event(new.id, 'case.ready', '{}'::jsonb);
  end if;
  return new;
end $$;

create trigger cases_events after insert or update on public.cases
  for each row execute function public.on_case_change();

-- Documents: uploaded, reviewed.
create function public.on_document_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.emit_event(new.case_id, 'document.uploaded',
      jsonb_build_object('documentId', new.id, 'checklistId', new.checklist_id, 'by', new.uploaded_role));
  elsif new.status is distinct from old.status then
    perform public.emit_event(new.case_id, 'document.reviewed',
      jsonb_build_object('documentId', new.id, 'checklistId', new.checklist_id, 'status', new.status));
  end if;
  return new;
end $$;

create trigger documents_events after insert or update on public.documents
  for each row execute function public.on_document_change();

-- Messages from clients (staff and automation messages do not need a reaction).
create function public.on_message_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.sender_role = 'client' then
    perform public.emit_event(new.case_id, 'message.from_client', jsonb_build_object('messageId', new.id));
  end if;
  return new;
end $$;

create trigger messages_events after insert on public.messages
  for each row execute function public.on_message_insert();

-- Packages: built, approved, returned by the attorney.
create function public.on_package_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.emit_event(new.case_id, 'package.built',
      jsonb_build_object('version', new.version, 'forced', new.forced, 'by', new.built_by));
  elsif new.status is distinct from old.status then
    perform public.emit_event(new.case_id, 'package.' || new.status::text,
      jsonb_build_object('version', new.version));
  end if;
  return new;
end $$;

create trigger packages_events after insert or update on public.packages
  for each row execute function public.on_package_change();
