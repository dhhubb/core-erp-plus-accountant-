import { ApiError, withAuth } from '@/app/api/_lib';
import {
  FISCAL_DEVICE_TYPES,
  FISCAL_MODES,
  getFiscalIntegration,
  setFiscalIntegration,
  type FiscalDeviceType,
  type FiscalMode,
} from '@/fiscal';

interface IntegrationBody {
  device_type?: string;
  mode?: string;
  payload?: Record<string, unknown>;
}

/**
 * GET /api/fiscal/integration — the branch's fiscal integration row (device, mode, status).
 * Org/branch scoped through RLS.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const integration = await getFiscalIntegration(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
    });
    if (!integration) return { integration: null };
    return {
      integration: {
        id: integration.id,
        device_type: integration.deviceType,
        mode: integration.mode,
        status: integration.status,
        last_sync: integration.lastSync,
        payload: integration.payload,
        created_at: integration.createdAt,
      },
    };
  });
}

/**
 * PUT /api/fiscal/integration — set the branch's device and mode. The mode is one of 'none' or
 * 'async'; there is no blocking mode in this run (ADR-0022).
 */
export async function PUT(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as IntegrationBody;

    if (
      body.device_type !== undefined &&
      !FISCAL_DEVICE_TYPES.includes(body.device_type as FiscalDeviceType)
    ) {
      throw new ApiError(422, `unknown fiscal device type ${body.device_type}`);
    }
    if (body.mode !== undefined && !FISCAL_MODES.includes(body.mode as FiscalMode)) {
      throw new ApiError(422, `unknown fiscal mode ${body.mode}`);
    }

    const integration = await setFiscalIntegration(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      ...(body.device_type !== undefined ? { deviceType: body.device_type as FiscalDeviceType } : {}),
      ...(body.mode !== undefined ? { mode: body.mode as FiscalMode } : {}),
      ...(body.payload !== undefined ? { payload: body.payload } : {}),
    });

    return {
      integration: {
        id: integration.id,
        device_type: integration.deviceType,
        mode: integration.mode,
        status: integration.status,
        last_sync: integration.lastSync,
        payload: integration.payload,
        created_at: integration.createdAt,
      },
    };
  });
}
