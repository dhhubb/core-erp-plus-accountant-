/**
 * The till's offline outbox. A sale that cannot reach the server is written to IndexedDB before
 * anything else, so it survives a page reload, a crash or a flat battery. The entry keeps the
 * client_sale_id generated at sale time (the server's idempotency key), the shift, the local
 * timestamp, the lines with the prices actually charged, the promotions that applied, and the
 * tenders.
 *
 * IndexedDB is the right store: it is transactional, it survives reloads, and a multi-megabyte
 * backlog does not compete with the cart's in-memory state.
 */

import Decimal from 'decimal.js';

export const OUTBOX_DB_NAME = 'erp-pos-outbox';
export const OUTBOX_DB_VERSION = 1;
export const OUTBOX_STORE = 'sales';

/** Retry schedule: exponential backoff with jitter, capped at five minutes. */
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000;
export const OUTBOX_BASE_BACKOFF_MS = 2 * 1000;

export interface OutboxLine {
  variantId: string;
  barcode: string | null;
  qty: string;
  unitPrice: string;
  /** Promotion ids that were applied to this line when it was rung. */
  promotionIds: string[];
}

export interface OutboxTender {
  method: string;
  currency: string;
  amountTendered: string;
}

export interface OutboxSale {
  /** Generated at sale time; the server's idempotency key. */
  clientSaleId: string;
  shiftId: string | null;
  warehouseId: string;
  /** The till's clock at the moment of the sale (ISO 8601). */
  soldAt: string;
  currency: string;
  lines: OutboxLine[];
  tenders: OutboxTender[];
  /** Delivery bookkeeping. */
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'clientSaleId' });
        store.createIndex('nextAttemptAt', 'nextAttemptAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open the outbox'));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(OUTBOX_STORE, mode);
        const request = fn(transaction.objectStore(OUTBOX_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('outbox request failed'));
        transaction.oncomplete = () => db.close();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('outbox transaction aborted'));
      }),
  );
}

/** Backoff for attempt n (0-based): base * 2^n, jittered, capped at five minutes. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** attempts, OUTBOX_MAX_BACKOFF_MS);
  // Full jitter: somewhere in [0, exponential]. Never longer than the cap.
  return Math.floor(random() * exponential);
}

export async function enqueueSale(sale: Omit<OutboxSale, 'attempts' | 'nextAttemptAt' | 'lastError'>): Promise<OutboxSale> {
  const entry: OutboxSale = { ...sale, attempts: 0, nextAttemptAt: 0, lastError: null };
  await runTransaction('readwrite', (store) => store.put(entry));
  return entry;
}

export async function getSale(clientSaleId: string): Promise<OutboxSale | undefined> {
  const result = await runTransaction<OutboxSale | undefined>('readonly', (store) =>
    store.get(clientSaleId),
  );
  return result;
}

/** Every queued sale, oldest first. */
export async function listPending(): Promise<OutboxSale[]> {
  const result = await runTransaction<OutboxSale[]>('readonly', (store) => store.getAll());
  return result.sort((a, b) => a.soldAt.localeCompare(b.soldAt));
}

export async function countPending(): Promise<number> {
  return runTransaction<number>('readonly', (store) => store.count());
}

export async function removeSale(clientSaleId: string): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(clientSaleId));
}

/** Record a failed delivery attempt and schedule the next one with backoff. */
export async function markAttempt(
  clientSaleId: string,
  error: string,
  random: () => number = Math.random,
): Promise<void> {
  const sale = await getSale(clientSaleId);
  if (!sale) return;
  const attempts = sale.attempts + 1;
  const updated: OutboxSale = {
    ...sale,
    attempts,
    lastError: error,
    nextAttemptAt: Date.now() + backoffDelay(attempts, random),
  };
  await runTransaction('readwrite', (store) => store.put(updated));
}

/** Clear the outbox. Used by tests and by an operator reset. */
export async function clearOutbox(): Promise<void> {
  await runTransaction('readwrite', (store) => store.clear());
}

/** The wire shape the sync endpoint accepts for one queued sale. */
export function toSyncPayload(sale: OutboxSale): {
  client_sale_id: string;
  shift_id: string | null;
  warehouse_id: string;
  sold_at: string;
  lines: Array<{ variant_id: string; barcode: string | null; qty: string; unit_price: string }>;
  tenders: Array<{ method: string; currency: string; amount_tendered: string }>;
} {
  return {
    client_sale_id: sale.clientSaleId,
    shift_id: sale.shiftId,
    warehouse_id: sale.warehouseId,
    sold_at: sale.soldAt,
    lines: sale.lines.map((line) => ({
      variant_id: line.variantId,
      barcode: line.barcode,
      qty: new Decimal(line.qty).toFixed(4),
      unit_price: new Decimal(line.unitPrice).toFixed(4),
    })),
    tenders: sale.tenders.map((tender) => ({
      method: tender.method,
      currency: tender.currency,
      amount_tendered: new Decimal(tender.amountTendered).toFixed(4),
    })),
  };
}
