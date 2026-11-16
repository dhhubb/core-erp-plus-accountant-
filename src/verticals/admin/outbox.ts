/**
 * The admin's offline queue of product edits. A product/category/variant/batch write that cannot
 * reach the server is written to IndexedDB first, so a branch admin working offline does not lose
 * the edit. It is the same outbox pattern the till uses for sales (ADR-0015): an entry keeps a
 * client-generated id (the server's idempotency key where the write is idempotent), the method, the
 * path, the JSON body and its backoff bookkeeping.
 *
 * IndexedDB is the right store: it is transactional, survives a reload, and a backlog does not
 * compete with the page's in-memory state.
 */

export const ADMIN_OUTBOX_DB_NAME = 'erp-admin-outbox';
export const ADMIN_OUTBOX_DB_VERSION = 1;
export const ADMIN_OUTBOX_STORE = 'edits';

export const ADMIN_OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000;
export const ADMIN_OUTBOX_BASE_BACKOFF_MS = 2 * 1000;

export type AdminMethod = 'POST' | 'PATCH' | 'DELETE';

export interface AdminEdit {
  /** Generated at edit time; unique per queued edit. */
  editId: string;
  method: AdminMethod;
  path: string;
  body: Record<string, unknown> | null;
  /** The edit's local clock (ISO 8601). */
  editedAt: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ADMIN_OUTBOX_DB_NAME, ADMIN_OUTBOX_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ADMIN_OUTBOX_STORE)) {
        const store = db.createObjectStore(ADMIN_OUTBOX_STORE, { keyPath: 'editId' });
        store.createIndex('nextAttemptAt', 'nextAttemptAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open the admin outbox'));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(ADMIN_OUTBOX_STORE, mode);
        const request = fn(transaction.objectStore(ADMIN_OUTBOX_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('admin outbox request failed'));
        transaction.oncomplete = () => db.close();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('admin outbox transaction aborted'));
      }),
  );
}

/** Backoff for attempt n (0-based): base * 2^n, jittered, capped at five minutes. */
export function adminBackoffDelay(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    ADMIN_OUTBOX_BASE_BACKOFF_MS * 2 ** attempts,
    ADMIN_OUTBOX_MAX_BACKOFF_MS,
  );
  return Math.floor(random() * exponential);
}

export async function enqueueEdit(
  edit: Omit<AdminEdit, 'attempts' | 'nextAttemptAt' | 'lastError'>,
): Promise<AdminEdit> {
  const entry: AdminEdit = { ...edit, attempts: 0, nextAttemptAt: 0, lastError: null };
  await runTransaction('readwrite', (store) => store.put(entry));
  return entry;
}

export async function getEdit(editId: string): Promise<AdminEdit | undefined> {
  return runTransaction<AdminEdit | undefined>('readonly', (store) => store.get(editId));
}

/** Every queued edit, oldest first. */
export async function listEdits(): Promise<AdminEdit[]> {
  const result = await runTransaction<AdminEdit[]>('readonly', (store) => store.getAll());
  return result.sort((a, b) => a.editedAt.localeCompare(b.editedAt));
}

export async function countEdits(): Promise<number> {
  return runTransaction<number>('readonly', (store) => store.count());
}

export async function removeEdit(editId: string): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(editId));
}

/** Record a failed delivery attempt and schedule the next one with backoff. */
export async function markEditAttempt(
  editId: string,
  error: string,
  random: () => number = Math.random,
): Promise<void> {
  const edit = await getEdit(editId);
  if (!edit) return;
  const attempts = edit.attempts + 1;
  const updated: AdminEdit = {
    ...edit,
    attempts,
    lastError: error,
    nextAttemptAt: Date.now() + adminBackoffDelay(attempts, random),
  };
  await runTransaction('readwrite', (store) => store.put(updated));
}

export async function clearEdits(): Promise<void> {
  await runTransaction('readwrite', (store) => store.clear());
}
