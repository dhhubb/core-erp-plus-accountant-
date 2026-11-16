import { withAuth } from '../../_lib';
import { requireOrg } from '../_shared';
import { listWarehouses } from '@/verticals/admin';

/** GET /api/admin/warehouses — the branch's active warehouses, for the admin pickers. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const warehouses = await listWarehouses(client, { orgId, branchId: claims.branchIds[0]! });
    return {
      warehouses: warehouses.map((warehouse) => ({
        id: warehouse.id,
        code: warehouse.code,
        name: warehouse.name,
        allow_negative_stock: warehouse.allowNegativeStock,
      })),
    };
  });
}
