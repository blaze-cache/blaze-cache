import type { CachePersistence, IndexedDbOptions, PersistedRecord } from './types.js';

const DEFAULT_DATABASE = 'blaze-cache';
const DEFAULT_STORE = 'entries';
const DEFAULT_NAMESPACE = 'default';
const DB_VERSION = 1;

/** `PersistedRecord` plus the composite primary key and namespace index. */
interface StoredRecord extends PersistedRecord {
  id: string;
  ns: string;
}

/**
 * IndexedDB-backed persistence.
 *
 * One database holds one object store; records from different caches are separated by a
 * `namespace` field with its own index, so several `BlazeCache` instances can share a
 * database without stepping on each other.
 *
 * ```ts
 * const cache = await createCache({
 *   persistence: { namespace: 'session-42', flushDelayMs: 250 },
 * });
 * ```
 *
 * Failures reject with a normal `Error` — `BlazeCache.create` catches them, warns, and keeps
 * running memory-only (private browsing modes routinely block IndexedDB).
 */
export function indexedDbPersistence(options: IndexedDbOptions = {}): CachePersistence {
  const database = options.database ?? DEFAULT_DATABASE;
  const store = options.store ?? DEFAULT_STORE;
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  // `\0` cannot appear in a namespace we control, so the composite key is unambiguous.
  const idFor = (key: string): string => `${namespace}\u0000${key}`;

  let opening: Promise<IDBDatabase> | null = null;

  const open = (version?: number): Promise<IDBDatabase> => {
    if (opening) return opening;

    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request =
        version === undefined ? indexedDB.open(database) : indexedDB.open(database, version);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) {
          const objectStore = db.createObjectStore(store, { keyPath: 'id' });
          objectStore.createIndex('ns', 'ns', { unique: false });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(store)) {
          resolve(db);
          return;
        }
        // The database already existed without our store: close it, bump the version, and let
        // `onupgradeneeded` create the store on the retry.
        const next = db.version + 1;
        db.close();
        opening = null;
        void open(next).then(resolve, reject);
      };

      request.onerror = () => {
        reject(request.error ?? new Error(`blaze-cache: failed to open IndexedDB "${database}"`));
      };
      request.onblocked = () => {
        reject(new Error(`blaze-cache: IndexedDB "${database}" is blocked by another tab`));
      };
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });

    return opening;
  };

  const runTransaction = (
    db: IDBDatabase,
    mode: IDBTransactionMode,
    body: (objectStore: IDBObjectStore) => void,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      try {
        body(tx.objectStore(store));
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('blaze-cache: IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('blaze-cache: IndexedDB transaction aborted'));
    });

  const indexKeys = (db: IDBDatabase): Promise<IDBValidKey[]> =>
    new Promise<IDBValidKey[]>((resolve, reject) => {
      const index = db.transaction(store, 'readonly').objectStore(store).index('ns');
      const request = index.getAllKeys(namespace);
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error('blaze-cache: failed to read IndexedDB'));
    });

  return {
    async load(): Promise<PersistedRecord[]> {
      const db = await open();
      const rows = await new Promise<StoredRecord[]>((resolve, reject) => {
        const index = db.transaction(store, 'readonly').objectStore(store).index('ns');
        const request = index.getAll(namespace);
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () =>
          reject(request.error ?? new Error('blaze-cache: failed to read IndexedDB'));
      });
      return rows.map(({ key, value, tags, ttlMs, storedAt }) => ({
        key,
        value,
        tags: tags ?? [],
        ttlMs: ttlMs ?? null,
        storedAt: storedAt ?? 0,
      }));
    },

    async save(records: PersistedRecord[]): Promise<void> {
      if (records.length === 0) return;
      const db = await open();
      await runTransaction(db, 'readwrite', (objectStore) => {
        for (const record of records) {
          objectStore.put({ ...record, id: idFor(record.key), ns: namespace } satisfies StoredRecord);
        }
      });
    },

    async remove(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      const db = await open();
      await runTransaction(db, 'readwrite', (objectStore) => {
        for (const key of keys) objectStore.delete(idFor(key));
      });
    },

    async clear(): Promise<void> {
      const db = await open();
      // Only this namespace — `objectStore.clear()` would wipe every cache sharing the store.
      const keys = await indexKeys(db);
      if (keys.length === 0) return;
      await runTransaction(db, 'readwrite', (objectStore) => {
        for (const key of keys) objectStore.delete(key);
      });
    },

    async close(): Promise<void> {
      if (!opening) return;
      // Closing is best-effort: a failed connection must not break disposal.
      const db = await opening.catch(() => null);
      opening = null;
      db?.close();
    },
  };
}
