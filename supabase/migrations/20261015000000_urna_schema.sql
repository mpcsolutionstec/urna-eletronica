create extension if not exists pgcrypto;

create table if not exists public.elections (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  offices text[] not null check (cardinality(offices) between 1 and 12),
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  chain_head text not null default repeat('0', 64),
  vote_count bigint not null default 0 check (vote_count >= 0),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.voters (
  id uuid primary key default gen_random_uuid(),
  cpf_hash text not null unique check (cpf_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.participation (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  voter_id uuid not null references public.voters(id) on delete cascade,
  voted boolean not null default false,
  voted_offices text[] not null default '{}',
  created_at timestamptz not null default now(),
  voted_at timestamptz,
  unique (election_id, voter_id)
);

create table if not exists public.candidates (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  office text not null check (char_length(office) between 1 and 60),
  number text not null check (number ~ '^[0-9]{2,5}$'),
  name text not null check (char_length(name) between 1 and 120),
  party text not null check (char_length(party) between 1 and 40),
  photo_url text check (photo_url is null or photo_url ~ '^https://'),
  created_at timestamptz not null default now(),
  unique (election_id, office, number),
  unique (id, election_id, office, number)
);

create table if not exists public.voter_releases (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  election_id uuid not null references public.elections(id) on delete cascade,
  participation_id uuid not null references public.participation(id) on delete cascade,
  used_offices text[] not null default '{}',
  used boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ballots (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.elections(id) on delete cascade,
  office text not null,
  choice text not null check (choice in ('candidate', 'blank', 'null')),
  candidate_number text,
  nonce text not null,
  recorded_at timestamptz not null,
  sequence bigint not null,
  previous_digest text not null,
  digest text not null,
  signature text not null,
  payload_json text not null,
  unique (election_id, sequence),
  check ((choice = 'candidate' and candidate_number is not null) or (choice <> 'candidate' and candidate_number is null))
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.bulletins (
  election_id uuid primary key references public.elections(id) on delete cascade,
  body jsonb not null,
  integrity text not null,
  created_at timestamptz not null default now()
);

create index if not exists participation_election_idx on public.participation(election_id);
create index if not exists candidates_election_idx on public.candidates(election_id);
create index if not exists ballots_election_sequence_idx on public.ballots(election_id, sequence);

create or replace function public.change_election_status(p_election_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  if p_status not in ('open', 'closed') then raise exception 'INVALID_STATUS'; end if;
  select status into v_status from public.elections where id = p_election_id for update;
  if not found then raise exception 'ELECTION_NOT_FOUND'; end if;
  if p_status = 'open' and v_status <> 'draft' then raise exception 'INVALID_STATUS_TRANSITION'; end if;
  if p_status = 'closed' and v_status <> 'open' then raise exception 'INVALID_STATUS_TRANSITION'; end if;
  update public.elections set status = p_status,
    closed_at = case when p_status = 'closed' then now() else null end
    where id = p_election_id;
end;
$$;

alter table public.elections enable row level security;
alter table public.voters enable row level security;
alter table public.participation enable row level security;
alter table public.candidates enable row level security;
alter table public.voter_releases enable row level security;
alter table public.ballots enable row level security;
alter table public.audit_logs enable row level security;
alter table public.bulletins enable row level security;

revoke all on public.elections, public.voters, public.participation, public.candidates,
  public.voter_releases, public.ballots, public.audit_logs, public.bulletins
  from anon, authenticated;
grant all on public.elections, public.voters, public.participation, public.candidates,
  public.voter_releases, public.ballots, public.audit_logs, public.bulletins
  to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.register_voter(p_election_id uuid, p_cpf_hash text, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_election public.elections%rowtype;
  v_voter_id uuid;
  v_participation_id uuid;
begin
  select * into v_election from public.elections where id = p_election_id for update;
  if not found or v_election.status <> 'draft' then raise exception 'ELECTION_NOT_DRAFT'; end if;
  insert into public.voters (cpf_hash, name) values (p_cpf_hash, p_name)
    on conflict (cpf_hash) do update set name = excluded.name returning id into v_voter_id;
  insert into public.participation (election_id, voter_id) values (p_election_id, v_voter_id)
    on conflict (election_id, voter_id) do nothing returning id into v_participation_id;
  if v_participation_id is null then raise exception 'VOTER_ALREADY_REGISTERED'; end if;
  return v_participation_id;
end;
$$;

create or replace function public.register_candidate(
  p_election_id uuid, p_office text, p_number text, p_name text, p_party text, p_photo_url text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_election public.elections%rowtype;
  v_id uuid;
begin
  select * into v_election from public.elections where id = p_election_id for update;
  if not found or v_election.status <> 'draft' then raise exception 'ELECTION_NOT_DRAFT'; end if;
  if not (p_office = any(v_election.offices)) then raise exception 'OFFICE_NOT_IN_ELECTION'; end if;
  insert into public.candidates (election_id, office, number, name, party, photo_url)
    values (p_election_id, p_office, p_number, p_name, p_party, p_photo_url) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'CANDIDATE_NUMBER_EXISTS';
end;
$$;

create or replace function public.release_voter(
  p_election_id uuid, p_cpf_hash text, p_token_hash text, p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_participation public.participation%rowtype;
  v_voter_id uuid;
begin
  perform 1 from public.elections where id = p_election_id and status = 'open' for update;
  if not found then raise exception 'ELECTION_NOT_OPEN'; end if;
  select id into v_voter_id from public.voters where cpf_hash = p_cpf_hash;
  if not found then raise exception 'VOTER_NOT_REGISTERED'; end if;
  select * into v_participation from public.participation
    where election_id = p_election_id and voter_id = v_voter_id for update;
  if not found then raise exception 'VOTER_NOT_REGISTERED'; end if;
  if v_participation.voted then raise exception 'VOTER_ALREADY_VOTED'; end if;
  insert into public.voter_releases (token_hash, election_id, participation_id, expires_at)
    values (p_token_hash, p_election_id, v_participation.id, p_expires_at);
end;
$$;

drop function if exists public.record_vote(text, text, text, text, text, timestamptz, text);
create or replace function public.record_vote(
  p_election_id uuid, p_token_hash text, p_office text, p_choice text, p_candidate_number text,
  p_nonce text, p_recorded_at timestamptz, p_integrity_key text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_release public.voter_releases%rowtype;
  v_participation public.participation%rowtype;
  v_election public.elections%rowtype;
  v_payload text;
  v_previous text;
  v_digest text;
  v_signature text;
  v_sequence bigint;
  v_voted_offices text[];
begin
  select * into v_release from public.voter_releases where token_hash = p_token_hash for update;
  if not found or v_release.used or v_release.expires_at <= now() then raise exception 'TOKEN_INVALID'; end if;
  if v_release.election_id <> p_election_id then raise exception 'TOKEN_INVALID'; end if;
  select * into v_election from public.elections where id = v_release.election_id for update;
  if not found or v_election.status <> 'open' then raise exception 'ELECTION_NOT_OPEN'; end if;
  if not (p_office = any(v_election.offices)) or p_office = any(v_release.used_offices) then raise exception 'OFFICE_ALREADY_VOTED'; end if;
  select * into v_participation from public.participation where id = v_release.participation_id for update;
  if not found or v_participation.voted or p_office = any(v_participation.voted_offices) then raise exception 'VOTER_ALREADY_VOTED'; end if;
  if p_choice = 'candidate' and not exists (
    select 1 from public.candidates where election_id = v_election.id and office = p_office and number = p_candidate_number
  ) then raise exception 'CANDIDATE_NOT_FOUND'; end if;
  if p_choice not in ('candidate', 'blank', 'null') or (p_choice = 'candidate' and p_candidate_number is null)
    or (p_choice <> 'candidate' and p_candidate_number is not null) then raise exception 'INVALID_BALLOT'; end if;

  v_payload := jsonb_build_object(
    'electionId', v_election.id, 'office', p_office, 'choice', p_choice,
    'candidateNumber', p_candidate_number, 'nonce', p_nonce, 'recordedAt', p_recorded_at
  )::text;
  v_previous := v_election.chain_head;
  v_sequence := v_election.vote_count + 1;
  v_digest := encode(digest(v_previous || ':' || v_payload, 'sha256'), 'hex');
  v_signature := encode(hmac(v_digest, p_integrity_key, 'sha256'), 'hex');

  insert into public.ballots (election_id, office, choice, candidate_number, nonce, recorded_at,
    sequence, previous_digest, digest, signature, payload_json)
    values (v_election.id, p_office, p_choice, p_candidate_number, p_nonce, p_recorded_at,
      v_sequence, v_previous, v_digest, v_signature, v_payload);

  v_voted_offices := array_append(v_participation.voted_offices, p_office);
  update public.participation set voted_offices = v_voted_offices,
    voted = v_election.offices <@ v_voted_offices,
    voted_at = case when v_election.offices <@ v_voted_offices then now() else voted_at end
    where id = v_participation.id;
  update public.voter_releases set used_offices = array_append(used_offices, p_office),
    used = v_election.offices <@ array_append(used_offices, p_office)
    where token_hash = p_token_hash;
  update public.elections set chain_head = v_digest, vote_count = v_sequence where id = v_election.id;
end;
$$;

revoke all on function public.register_voter(uuid, text, text) from public, anon, authenticated;
revoke all on function public.change_election_status(uuid, text) from public, anon, authenticated;
revoke all on function public.register_candidate(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.release_voter(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_vote(uuid, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.register_voter(uuid, text, text) to service_role;
grant execute on function public.change_election_status(uuid, text) to service_role;
grant execute on function public.register_candidate(uuid, text, text, text, text, text) to service_role;
grant execute on function public.release_voter(uuid, text, text, timestamptz) to service_role;
grant execute on function public.record_vote(uuid, text, text, text, text, text, timestamptz, text) to service_role;
