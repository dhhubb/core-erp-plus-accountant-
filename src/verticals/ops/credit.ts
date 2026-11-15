import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { money, moneyFromSql } from '@/core/money';

export interface CreditLimit {
  contactId: string;
  creditLimit: Decimal;
}

/** Read a customer's credit ceiling, or null when none is set. */
export async function getCreditLimit(
  client: PoolClient,
  input: { orgId: string; contactId: string },
): Promise<CreditLimit | null> {
  const result = await client.query<{ contact_id: string; credit_limit: string }>(
    `select contact_id, credit_limit::text
       from public.credit_limits
      where org_id = $1 and contact_id = $2`,
    [input.orgId, input.contactId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { contactId: row.contact_id, creditLimit: moneyFromSql(row.credit_limit) };
}

/** Set or raise a customer's credit ceiling. */
export async function setCreditLimit(
  client: PoolClient,
  input: { orgId: string; contactId: string; creditLimit: string | Decimal },
): Promise<CreditLimit> {
  const result = await client.query<{ contact_id: string; credit_limit: string }>(
    `insert into public.credit_limits (org_id, contact_id, credit_limit)
     values ($1, $2, $3)
     on conflict (org_id, contact_id)
     do update set credit_limit = excluded.credit_limit, updated_at = now()
     returning contact_id, credit_limit::text`,
    [input.orgId, input.contactId, new Decimal(input.creditLimit).toFixed(4)],
  );
  const row = result.rows[0]!;
  return { contactId: row.contact_id, creditLimit: moneyFromSql(row.credit_limit) };
}

/**
 * Check a prospective credit sale against the ceiling. app.check_credit locks the contact row, so
 * concurrent checks serialise and none can each see the same headroom.
 */
export async function checkCredit(
  client: PoolClient,
  input: { orgId: string; contactId: string; amount: string | Decimal },
): Promise<Decimal | null> {
  const result = await client.query<{ app: string | null }>(
    `select app.check_credit($1, $2, $3) as app`,
    [input.orgId, input.contactId, new Decimal(input.amount).toFixed(4)],
  );
  const value = result.rows[0]!.app;
  return value === null ? null : money(value);
}
