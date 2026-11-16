import { BRANCH_PROTOCOL_VERSION, cloudProbeTimeoutMs, cloudUrl } from './config';

/**
 * Cloud connectivity.
 *
 * The branch makes outbound connections only (decision 14): it reaches the cloud, the cloud never
 * reaches it. A probe is a plain GET of the cloud's health endpoint with a short timeout, so a
 * health read never hangs. The result is a small, explicit status the branch stores and the till
 * reads.
 *
 * Note that this is deliberately NOT `navigator.onLine`: that flag stays true when the LAN is up
 * but the internet is down, which is exactly the case a branch must report as "cloud offline".
 */

export type CloudStatus = 'online' | 'offline' | 'incompatible';

export interface CloudProbeResult {
  status: CloudStatus;
  /** The protocol version the cloud reported, when it answered. */
  cloudProtocolVersion: number | null;
}

export interface CloudProbeOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** The branch's protocol version, compared against the cloud's. */
  protocolVersion: number;
  timeoutMs?: number;
}

/**
 * Probe the cloud once. Any network failure, timeout or non-2xx answer means `offline`. A reachable
 * cloud that reports a different protocol version means `incompatible` (decision 17): the branch
 * will refuse to push and the till shows a warning.
 */
export async function probeCloud(
  url: string | null,
  options: CloudProbeOptions,
): Promise<CloudProbeResult> {
  if (!url) return { status: 'offline', cloudProtocolVersion: null };

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? cloudProbeTimeoutMs());

  try {
    const response = await doFetch(`${url}/api/branch/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'offline', cloudProtocolVersion: null };

    const payload = (await response.json()) as { protocol_version?: unknown };
    const version =
      typeof payload.protocol_version === 'number' ? payload.protocol_version : null;

    if (version !== null && version !== options.protocolVersion) {
      return { status: 'incompatible', cloudProtocolVersion: version };
    }
    return { status: 'online', cloudProtocolVersion: version };
  } catch {
    return { status: 'offline', cloudProtocolVersion: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the cloud using the configured URL and this build's protocol version. */
export async function probeConfiguredCloud(
  options: Omit<CloudProbeOptions, 'protocolVersion'> & { protocolVersion?: number } = {},
): Promise<CloudProbeResult> {
  const { protocolVersion, ...rest } = options;
  return probeCloud(cloudUrl(), {
    ...rest,
    protocolVersion: protocolVersion ?? BRANCH_PROTOCOL_VERSION,
  });
}
