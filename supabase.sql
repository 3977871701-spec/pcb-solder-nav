create table if not exists public.psn_boards (
  user_id uuid not null references auth.users(id) on delete cascade,
  board_key text not null,
  payload jsonb,
  updated_at timestamptz not null,
  deleted boolean not null default false,
  primary key (user_id, board_key)
);

alter table public.psn_boards enable row level security;

revoke all on table public.psn_boards from anon;
grant select, insert, update on table public.psn_boards to authenticated;

drop policy if exists "Users manage their own PCB boards" on public.psn_boards;
create policy "Users manage their own PCB boards"
on public.psn_boards for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
