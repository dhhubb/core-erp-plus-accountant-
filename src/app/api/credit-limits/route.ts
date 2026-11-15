import { ApiError, withAuth } from '../_lib';
import { checkCredit, getCreditLimit, setCreditLimit } from '@/verticals/ops/credit';

interface SetCreditLimitBody {
  contact_id: string;
  credit_limit: string;
}

interface CheckCreditBody {
  contact_id: string;
  amount: string;
}

/** GET /api/credit-limits?contact_id= — the ceiling and current headroom for a customer. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const contactId = new URL(request.url).searchParams.get('contact_id');
    if (!contactId) {
      throw new ApiError(422, 'contact_id is required');
    }

    const limit = await getCreditLimit(client, { orgId: claims.orgId!, contactId });
    return {
      contact_id: contactId,
      credit_limit: limit ? limit.creditLimit.toFixed(4) : null,
    };
  });
}

/**
 * POST /api/credit-limits — set a ceiling, or check a prospective sale by passing `amount`.
 * A check over the ceiling raises, so the handler surfaces it as 422.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as SetCreditLimitBody | CheckCreditBody;

    if ((body as CheckCreditBody).amount !== undefined) {
      const input = body as CheckCreditBody;
      const headroom = await checkCredit(client, {
        orgId: claims.orgId!,
        contactId: input.contact_id,
        amount: input.amount,
      });
      return {
        contact_id: input.contact_id,
        allowed: true,
        headroom: headroom ? headroom.toFixed(4) : null,
      };
    }

    const input = body as SetCreditLimitBody;
    const limit = await setCreditLimit(client, {
      orgId: claims.orgId!,
      contactId: input.contact_id,
      creditLimit: input.credit_limit,
    });
    return { contact_id: limit.contactId, credit_limit: limit.creditLimit.toFixed(4) };
  });
}
