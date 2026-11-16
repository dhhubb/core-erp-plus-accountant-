import { ApiError, withAuth } from '@/app/api/_lib';
import { loadPrinterSettings, savePrinterSettings, type PrinterMode } from '@/verticals/pos/printing';

interface PrinterBody {
  mode?: PrinterMode;
  host?: string | null;
  port?: number;
  label?: string;
}

function serialise(settings: {
  mode: PrinterMode;
  host: string | null;
  port: number;
  label: string;
}) {
  return { mode: settings.mode, host: settings.host, port: settings.port, label: settings.label };
}

/** GET /api/pos/printer — the branch's printer settings. Falls back to browser mode. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const url = new URL(request.url);
    const label = url.searchParams.get('label') ?? 'default';
    const settings = await loadPrinterSettings(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      label,
    });
    return serialise(settings);
  });
}

/** PUT /api/pos/printer — save the branch's printer settings (browser or network printer). */
export async function PUT(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as PrinterBody;
    const mode = body.mode ?? 'browser';
    if (mode !== 'browser' && mode !== 'network') {
      throw new ApiError(422, 'mode must be browser or network');
    }
    if (mode === 'network' && (!body.host || body.host.trim() === '')) {
      throw new ApiError(422, 'a network printer requires a host');
    }
    const port = body.port ?? 9100;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(422, 'port must be between 1 and 65535');
    }

    const settings = await savePrinterSettings(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      mode,
      host: mode === 'network' ? (body.host ?? '').trim() : null,
      port,
      label: body.label ?? 'default',
    });
    return serialise(settings);
  });
}
