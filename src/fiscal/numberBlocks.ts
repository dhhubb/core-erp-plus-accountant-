import type { PoolClient } from 'pg';

/**
 * Number blocks (H3). Invoice numbers are gapless and never reused. The cloud reserves a
 * contiguous block for each branch; the branch takes numbers from its local block and requests the
 * NEXT block before the current one runs out, so a branch that goes offline still has headroom.
 *
 * When a block runs out while the branch is offline and no block is left to claim, the sale fails
 * with a clear message and no number is reused (`app.claim_invoice_number` raises).
 */

export interface NumberBlockStatus {
  exhausted: boolean;
  remaining: number;
  blockNo: string | null;
  firstValue?: string;
  lastValue?: string;
  nextValue?: string;
}

interface RawBlockStatus {
  exhausted: boolean;
  remaining: number | string;
  block_no: string | null;
  first_value?: string | null;
  last_value?: string | null;
  next_value?: string | null;
}

function toStatus(raw: RawBlockStatus): NumberBlockStatus {
  return {
    exhausted: raw.exhausted,
    remaining: Number(raw.remaining),
    blockNo: raw.block_no,
    ...(raw.first_value != null ? { firstValue: String(raw.first_value) } : {}),
    ...(raw.last_value != null ? { lastValue: String(raw.last_value) } : {}),
    ...(raw.next_value != null ? { nextValue: String(raw.next_value) } : {}),
  };
}

/** The branch's current block state (remaining numbers, bounds, exhaustion). */
export async function numberBlockStatus(
  client: PoolClient,
  input: { orgId: string; branchId: string; seriesCode?: string },
): Promise<NumberBlockStatus> {
  const result = await client.query<{ app: RawBlockStatus }>(
    `select app.number_block_status($1, $2, $3) as app`,
    [input.orgId, input.branchId, input.seriesCode ?? 'INVOICE'],
  );
  return toStatus(result.rows[0]!.app);
}

/** A block as the cloud issues it. */
export interface IssuedBlock {
  blockNo: string;
  firstValue: string;
  lastValue: string;
  size: number;
}

interface RawIssuedBlock {
  block_no: string | number;
  first_value: string | number;
  last_value: string | number;
  size: number;
}

function toIssued(raw: RawIssuedBlock): IssuedBlock {
  return {
    blockNo: String(raw.block_no),
    firstValue: String(raw.first_value),
    lastValue: String(raw.last_value),
    size: Number(raw.size),
  };
}

/** Cloud: reserve the next block for a branch. */
export async function issueNumberBlock(
  client: PoolClient,
  input: { orgId: string; branchId: string; seriesCode?: string; size?: number },
): Promise<IssuedBlock> {
  const result = await client.query<{ app: RawIssuedBlock }>(
    `select app.issue_number_block($1, $2, $3, $4) as app`,
    [input.orgId, input.branchId, input.seriesCode ?? 'INVOICE', input.size ?? 200],
  );
  return toIssued(result.rows[0]!.app);
}

/** Branch: store a block the cloud issued (idempotent on the block number). */
export async function storeNumberBlock(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    block: IssuedBlock;
    seriesCode?: string;
  },
): Promise<NumberBlockStatus> {
  const result = await client.query<{ app: RawBlockStatus }>(
    `select app.store_number_block($1, $2, $3, $4, $5, $6) as app`,
    [
      input.orgId,
      input.branchId,
      input.block.blockNo,
      input.block.firstValue,
      input.block.lastValue,
      input.seriesCode ?? 'INVOICE',
    ],
  );
  return toStatus(result.rows[0]!.app);
}

/**
 * A block fetcher: how the branch asks the cloud for the next block. The gate injects a local
 * fetcher; a real deployment uses `cloudBlockFetcher`, which POSTs to the cloud.
 */
export type NumberBlockFetcher = () => Promise<IssuedBlock>;

/** Ask the cloud for the next block over HTTP. Needs the cloud URL and a branch token. */
export function cloudBlockFetcher(input: {
  cloudUrl: string;
  token: string;
  branchId: string;
  seriesCode?: string;
  size?: number;
  fetchImpl?: typeof fetch;
}): NumberBlockFetcher {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async () => {
    const response = await fetchImpl(`${input.cloudUrl.replace(/\/+$/, '')}/api/branch/numbers/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        branch_id: input.branchId,
        series_code: input.seriesCode ?? 'INVOICE',
        size: input.size ?? 200,
      }),
    });
    if (!response.ok) {
      throw new Error(`cloud refused a number block: ${response.status}`);
    }
    const body = (await response.json()) as { block: RawIssuedBlock };
    return toIssued(body.block);
  };
}

/** How many numbers must remain before the branch asks the cloud for the next block. */
export const NUMBER_BLOCK_LOW_WATER = 20;

export interface EnsureBlockResult {
  status: NumberBlockStatus;
  requested: boolean;
}

/**
 * Request the next block BEFORE the current one is used up. Called on the branch after each sale
 * (or on a timer): when the remaining count falls to the low-water mark, fetch a block and store it.
 * A failed fetch is not fatal — the branch keeps using what it has — so an offline branch keeps
 * selling until its block really runs out.
 */
export async function ensureNextBlock(
  client: PoolClient,
  fetchBlock: NumberBlockFetcher,
  input: { orgId: string; branchId: string; seriesCode?: string; lowWater?: number },
): Promise<EnsureBlockResult> {
  const lowWater = input.lowWater ?? NUMBER_BLOCK_LOW_WATER;
  const before = await numberBlockStatus(client, input);

  // Nothing to top up when a full block is still available, or when we are already exhausted (a
  // fetch would only help if the cloud is reachable, and the sale path handles exhaustion).
  if (!before.exhausted && before.remaining > lowWater) {
    return { status: before, requested: false };
  }

  try {
    const block = await fetchBlock();
    const status = await storeNumberBlock(client, {
      orgId: input.orgId,
      branchId: input.branchId,
      block,
      ...(input.seriesCode !== undefined ? { seriesCode: input.seriesCode } : {}),
    });
    return { status, requested: true };
  } catch {
    // Offline: keep the current block. The branch keeps selling until it truly runs out.
    return { status: before, requested: false };
  }
}
