import { ApiError, withAuth } from '@/app/api/_lib';
import { isBranchMode } from '@/branch/config';
import { relayEscPosBase64 } from '@/branch/printer';
import { generateEscPos, escPosToBase64 } from '@/verticals/pos/escpos';
import { loadPrinterSettings, sampleReceiptData } from '@/verticals/pos/printing';

interface TestPrintBody {
  host?: string;
  port?: number;
}

/**
 * POST /api/pos/printer/test — print a test slip.
 *
 * In network mode the branch relays the sample ESC/POS bytes to the configured printer, so the
 * operator can confirm paper, alignment and the cut. In browser mode there is nothing to relay (the
 * browser owns the dialog), so the route returns the bytes base64 for the page to render and the
 * page calls `window.print()`.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json().catch(() => ({}))) as TestPrintBody;
    const settings = await loadPrinterSettings(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
    });

    const host = body.host ?? settings.host;
    const port = body.port ?? settings.port;
    const data = sampleReceiptData(claims.sub, new Date());
    const bytes = generateEscPos(data);

    if (settings.mode === 'network' && host) {
      if (!isBranchMode()) {
        throw new ApiError(409, 'network printing is a branch-only operation');
      }
      try {
        const result = await relayEscPosBase64(escPosToBase64(bytes), { host, port });
        return { printed: result.printed, transport: 'network', bytes: result.bytes };
      } catch (error) {
        throw new ApiError(502, (error as Error).message);
      }
    }

    return { printed: false, transport: 'browser', base64: escPosToBase64(bytes) };
  });
}
