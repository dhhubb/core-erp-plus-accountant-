import { randomUUID } from 'node:crypto';
import type { AuthClaims } from '../../src/core/auth';
import { one, sql } from './db';

export interface Tenant {
  orgId: string;
  branchId: string;
  userId: string;
  email: string;
  claims: AuthClaims;
}

function tokenFor(userId: string, orgId: string | null, branchIds: string[]): AuthClaims {
  return {
    sub: userId,
    orgId,
    branchIds,
    role: 'authenticated',
    email: `user-${userId.slice(0, 8)}@example.test`,
  };
}

/** A token whose claims have been refreshed after a membership change. */
export function refreshedClaims(userId: string, orgId: string | null, branchIds: string[]): AuthClaims {
  return tokenFor(userId, orgId, branchIds);
}

export async function createAuthUser(email?: string): Promise<string> {
  const userId = randomUUID();
  await sql('insert into auth.users (id, email) values ($1, $2)', [
    userId,
    email ?? `u-${userId}@example.test`,
  ]);
  return userId;
}

export interface CreateTenantOptions {
  slug?: string;
  /** Add the membership row that the auth hook reads at token refresh. */
  withMembership?: boolean;
  branchIds?: string[];
}

/**
 * Create an organisation with a branch and one member. Returns the tenant plus a token whose
 * claims match the membership (what the access token hook would mint on refresh).
 */
export async function createTenant(name: string, options: CreateTenantOptions = {}): Promise<Tenant> {
  const slug = options.slug ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;

  const org = await one<{ create_org: string }>('select app.create_org($1, $2) as create_org', [
    name,
    slug,
  ]);
  if (!org) throw new Error('create_org returned no row');
  const orgId = org.create_org;

  const branch = await one<{ id: string }>(
    'insert into public.branches (org_id, name, slug) values ($1, $2, $3) returning id',
    [orgId, 'Main', 'main'],
  );
  if (!branch) throw new Error('branch insert returned no row');
  const branchId = branch.id;

  const userId = await createAuthUser();
  const withMembership = options.withMembership ?? true;
  const branchIds = options.branchIds ?? [branchId];

  if (withMembership) {
    await sql(
      `insert into public.memberships (org_id, user_id, role, branch_ids)
       values ($1, $2, 'owner', $3)`,
      [orgId, userId, branchIds],
    );
  }

  return {
    orgId,
    branchId,
    userId,
    email: `user-${userId.slice(0, 8)}@example.test`,
    claims: tokenFor(userId, orgId, branchIds),
  };
}

export async function addBranch(tenant: Tenant, name: string, slug?: string): Promise<string> {
  const row = await one<{ id: string }>(
    'insert into public.branches (org_id, name, slug) values ($1, $2, $3) returning id',
    [tenant.orgId, name, slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
  );
  if (!row) throw new Error('branch insert returned no row');
  return row.id;
}

export async function accountId(tenant: Tenant, code: string): Promise<string> {
  const row = await one<{ id: string }>(
    'select id from public.chart_of_accounts where org_id = $1 and code = $2',
    [tenant.orgId, code],
  );
  if (!row) throw new Error(`account ${code} not found`);
  return row.id;
}

export async function createFiscalPeriod(
  tenant: Tenant,
  startDate: string,
  endDate: string,
  isClosed: boolean,
): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into public.fiscal_periods (org_id, name, start_date, end_date, is_closed)
     values ($1, $2, $3, $4, $5) returning id`,
    [tenant.orgId, `${startDate}..${endDate}`, startDate, endDate, isClosed],
  );
  if (!row) throw new Error('fiscal period insert returned no row');
  return row.id;
}
