import { withAccountingAuth, requireOrg } from '../_shared';
import { accountList } from '@/accounting/reports';

/** GET /api/accounting/accounts — the org's active chart of accounts, for the ledger picker. */
export async function GET(request: Request) {
  return withAccountingAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const accounts = await accountList(client, { orgId });
    return {
      json: {
        accounts: accounts.map((account) => ({
          account_id: account.accountId,
          code: account.code,
          name: account.name,
          account_type: account.accountType,
        })),
      },
    };
  });
}
