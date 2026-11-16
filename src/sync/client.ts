/**
 * The branch's HTTP transport to the cloud.
 *
 * This is the only place the branch talks to the cloud. It maps transport failures to the retry
 * taxonomy (SyncNetworkError / SyncServerError are retryable) and a cloud rejection to a
 * SyncRejectionError carrying the rejected event ids, so the worker can tell a network outage from
 * a refusal.
 */

import { branchSyncToken, syncTimeoutMs } from './config';
import { SyncNetworkError, SyncRejectionError, SyncServerError } from './retry';
import type { MasterDataChange, PushResponse, SyncOutboxEvent } from './types';

async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const token = branchSyncToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), syncTimeoutMs());
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  } catch (error) {
    // A timeout, a DNS failure, a refused connection: all retryable, never a conflict.
    throw new SyncNetworkError((error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** The cloud base URL, or null when the branch has none configured. */
function cloudBase(cloudUrl: string | null): string {
  if (!cloudUrl) throw new SyncNetworkError('no cloud URL configured');
  return cloudUrl;
}

/** Push one batch of events. A 5xx is retryable; a 4xx naming events is a rejection. */
export async function deliverPush(
  cloudUrl: string | null,
  orgId: string,
  branchId: string,
  events: SyncOutboxEvent[],
): Promise<PushResponse> {
  const { status, json } = await post(`${cloudBase(cloudUrl)}/api/sync/push`, {
    org_id: orgId,
    branch_id: branchId,
    events,
  });

  if (status >= 200 && status < 300) {
    return json as PushResponse;
  }
  if (status >= 500) {
    throw new SyncServerError(`cloud push failed (${status})`);
  }
  const payload = (json ?? {}) as { rejects?: PushResponse['rejects']; error?: string };
  if (Array.isArray(payload.rejects) && payload.rejects.length > 0) {
    throw new SyncRejectionError(payload.error ?? `cloud rejected events (${status})`, payload.rejects);
  }
  throw new SyncRejectionError(payload.error ?? `cloud rejected the batch (${status})`, []);
}

/** Pull master-data changes after `sinceSeq`. */
export async function deliverPull(
  cloudUrl: string | null,
  orgId: string,
  branchId: string,
  sinceSeq: string,
): Promise<{ changes: MasterDataChange[] }> {
  const { status, json } = await post(`${cloudBase(cloudUrl)}/api/sync/pull`, {
    org_id: orgId,
    branch_id: branchId,
    since_seq: sinceSeq,
  });

  if (status >= 200 && status < 300) {
    return json as { changes: MasterDataChange[] };
  }
  if (status >= 500) {
    throw new SyncServerError(`cloud pull failed (${status})`);
  }
  throw new SyncServerError(`cloud pull returned ${status}`);
}
