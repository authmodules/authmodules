import { type PostgresClient } from '../database/types.ts'

export const postgresSchemaSql: string = `
create table if not exists authmodules_accounts (
  tenant_id text not null,
  account_id text not null,
  status text not null,
  public_data jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, account_id),
  check (status in ('active', 'disabled', 'deleted'))
);

create table if not exists authmodules_identities (
  tenant_id text not null,
  identity_id text not null,
  account_id text not null,
  method_id text not null,
  method_kind text not null,
  subject text not null,
  subject_kind text not null,
  display text,
  verified_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, identity_id),
  constraint authmodules_identities_subject_uniq unique (tenant_id, method_id, subject),
  constraint authmodules_identities_credential_binding_uniq unique (
    tenant_id,
    identity_id,
    account_id,
    method_id,
    method_kind
  ),
  foreign key (tenant_id, account_id)
    references authmodules_accounts (tenant_id, account_id)
    on delete restrict
);

create table if not exists authmodules_credentials (
  tenant_id text not null,
  credential_id text not null,
  account_id text not null,
  identity_id text not null,
  method_id text not null,
  method_kind text not null,
  status text not null,
  material jsonb not null,
  version integer not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, credential_id),
  constraint authmodules_credentials_identity_method_uniq unique (tenant_id, identity_id, method_id),
  foreign key (tenant_id, account_id)
    references authmodules_accounts (tenant_id, account_id)
    on delete restrict,
  foreign key (tenant_id, identity_id, account_id, method_id, method_kind)
    references authmodules_identities (tenant_id, identity_id, account_id, method_id, method_kind)
    on delete restrict,
  check (status in ('active', 'disabled')),
  check (version > 0)
);

create table if not exists authmodules_sessions (
  tenant_id text not null,
  session_id text not null,
  account_id text not null,
  token_hash jsonb not null,
  token_hash_scheme text not null,
  token_hash_key_id text not null,
  token_hash_value text not null,
  status text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, session_id),
  constraint authmodules_sessions_token_hash_uniq unique (
    tenant_id,
    token_hash_scheme,
    token_hash_key_id,
    token_hash_value
  ),
  foreign key (tenant_id, account_id)
    references authmodules_accounts (tenant_id, account_id)
    on delete restrict,
  check (status in ('active', 'revoked', 'expired')),
  check (length(token_hash_scheme) > 0),
  check (length(token_hash_value) > 0),
  check (jsonb_typeof(token_hash) = 'object'),
  check (token_hash ->> 'type' = 'protected-value'),
  check (token_hash ->> 'scheme' = token_hash_scheme),
  check (coalesce(token_hash ->> 'keyId', '') = token_hash_key_id),
  check (token_hash ->> 'value' = token_hash_value),
  check (expires_at > issued_at),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table if not exists authmodules_challenges (
  tenant_id text not null,
  challenge_id text not null,
  method_id text not null,
  method_kind text not null,
  lookup jsonb,
  status text not null,
  material jsonb not null,
  binding jsonb not null,
  attempts integer not null,
  max_attempts integer not null,
  version integer not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, challenge_id),
  check (status in ('pending', 'consumed', 'expired', 'failed')),
  check (attempts >= 0),
  check (max_attempts > 0),
  check (attempts <= max_attempts),
  check (version > 0),
  check ((status = 'consumed') = (consumed_at is not null))
);

create table if not exists authmodules_outbox (
  tenant_id text not null,
  message_id text not null,
  context jsonb not null,
  secret_purpose text not null,
  type text not null,
  message jsonb not null,
  dispatch_policy text not null,
  status text not null,
  attempts integer not null,
  max_attempts integer not null,
  last_failure_reason text,
  idempotency_key text,
  expires_at timestamptz,
  available_at timestamptz not null,
  lease_id text,
  worker_id text,
  lease_until timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint authmodules_outbox_pkey primary key (tenant_id, message_id),
  check (type = 'delivery'),
  check (dispatch_policy in ('required', 'best-effort')),
  check (status in ('pending', 'claimed', 'dispatched', 'failed', 'dead')),
  check (attempts >= 0),
  check (max_attempts > 0),
  check (attempts <= max_attempts),
  constraint authmodules_outbox_last_failure_reason
    check (last_failure_reason is null or length(last_failure_reason) between 1 and 512),
  constraint authmodules_outbox_required_idempotency
    check (dispatch_policy <> 'required' or idempotency_key is not null),
  check ((status = 'claimed') = (lease_id is not null and worker_id is not null and lease_until is not null))
);

alter table authmodules_outbox
  add column if not exists last_failure_reason text;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'authmodules_outbox'::regclass
      and conname = 'authmodules_outbox_last_failure_reason'
  ) then
    alter table authmodules_outbox
      add constraint authmodules_outbox_last_failure_reason
      check (last_failure_reason is null or length(last_failure_reason) between 1 and 512)
      not valid;
  end if;
end
$migration$;

alter table authmodules_outbox
  validate constraint authmodules_outbox_last_failure_reason;

update authmodules_outbox
set idempotency_key = message_id
where dispatch_policy = 'required' and idempotency_key is null;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'authmodules_outbox'::regclass
      and conname = 'authmodules_outbox_required_idempotency'
  ) then
    alter table authmodules_outbox
      add constraint authmodules_outbox_required_idempotency
      check (dispatch_policy <> 'required' or idempotency_key is not null)
      not valid;
  end if;
end
$migration$;

alter table authmodules_outbox
  validate constraint authmodules_outbox_required_idempotency;

create index if not exists authmodules_identities_account_idx
  on authmodules_identities (tenant_id, account_id);
create index if not exists authmodules_credentials_account_idx
  on authmodules_credentials (tenant_id, account_id);
create index if not exists authmodules_sessions_account_idx
  on authmodules_sessions (tenant_id, account_id);
create index if not exists authmodules_sessions_expiry_idx
  on authmodules_sessions (tenant_id, expires_at)
  where status = 'active';
create index if not exists authmodules_challenges_expiry_idx
  on authmodules_challenges (tenant_id, expires_at)
  where status = 'pending';
create index if not exists authmodules_outbox_claim_idx
  on authmodules_outbox (available_at, created_at, message_id)
  where status in ('pending', 'failed', 'claimed');
create index if not exists authmodules_outbox_expiry_idx
  on authmodules_outbox (expires_at, tenant_id, message_id)
  where status in ('pending', 'failed', 'claimed') and expires_at is not null;
create index if not exists authmodules_outbox_claimed_lease_idx
  on authmodules_outbox (lease_until, tenant_id, message_id)
  where status = 'claimed';
create index if not exists authmodules_outbox_retention_idx
  on authmodules_outbox (updated_at, tenant_id, message_id)
  where status in ('dispatched', 'dead');
create unique index if not exists authmodules_outbox_idempotency_uniq
  on authmodules_outbox (tenant_id, idempotency_key)
  where idempotency_key is not null;
`

export function installPostgresSchema(client: PostgresClient): Promise<void>

export async function installPostgresSchema(client: PostgresClient): Promise<void> {
  await client.query(postgresSchemaSql)
}
