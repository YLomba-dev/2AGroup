-- Supabase Auth stores app_metadata after it creates the user row, so the insert
-- trigger alone sees no role. Keep profiles.role in step with app_metadata.role, which
-- only the server (service role) can change.
create function public.sync_user_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_app_meta_data ->> 'role' in ('client', 'staff', 'attorney', 'admin') then
    update public.profiles
       set role = (new.raw_app_meta_data ->> 'role')::public.app_role
     where id = new.id
       and role is distinct from (new.raw_app_meta_data ->> 'role')::public.app_role;
  end if;
  return new;
end $$;

create trigger on_auth_user_role_changed
  after update of raw_app_meta_data on auth.users
  for each row execute function public.sync_user_role();

-- Bring existing accounts in line.
update public.profiles p
   set role = (u.raw_app_meta_data ->> 'role')::public.app_role
  from auth.users u
 where u.id = p.id
   and u.raw_app_meta_data ->> 'role' in ('client', 'staff', 'attorney', 'admin');
