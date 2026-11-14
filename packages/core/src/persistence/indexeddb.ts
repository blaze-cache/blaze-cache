import type {
  CachePersistence,
  IndexedDbOptions,
  PersistedRecord,
  PersistenceWriteOps,
} from './types.js';

const DEFAULT_DATABASE = 'blaze-cache';
const DEFAULT_STORE = 'entries';
const DEFAULT_NAMESPACE = 'default';
const DB_VERSION = 1;

/**
 * Schema version stamped on every row this package writes.
 *
 * v0 is *unversioned* — the rows releases before this stamp produced (they carry no `v`
 * field at all) and they are migrated forward by {@link MIGRATIONS}. A future change to
 * the record shape bumps this number and adds a migration step; a change no step can
 * bridge makes `load()` reset the namespace instead of hydrating nonsense.
 *
 * Rows stamped **higher** than this (written by a newer package, e.g. after a downgrade)
 * are never guessed at: the namespace is reset, which is safe precisely because a cache
 * is disposable — revalidation repopulates it.
 */
const SCHEMA_VERSION = 1;

/**
 * Steps from one schema version to the next: `MIGRATIONS[n]` upgrades a row from `n` to
 * `n + 1`. Returning `null` marks the row unusable (it is skipped like a corrupt one).
 *
 * The only step so far adopts v0 rows — their shape never changed, so the migration is
 * "keep them and let the next write stamp the version".
 */
const MIGRATIONS: Record<number, (row: Record<string, unknown>) => Record<string, unknown> | null> = {
  0: (row) => ({ ...row, v: SCHEMA_VERSION }),
};

/** `PersistedRecord` plus the composite primary key, namespace index and schema stamp. */
interface StoredRecord extends PersistedRecord {
  id: string;
  ns: string;
  v: number;
}

/**
 * IndexedDB-backed persistence.
 *
 * One database holds one object store; records from different caches are separated by a
 * `namespace` field with its own index, so several `BlazeCache` instances can share a
 * database without stepping on each other. A {@link IndexedDbOptions.generation} is
 * folded into that namespace (`namespace\0generation`), which is what keeps one account's
 * rows — including writes still in flight when the account switched — invisible to the
 * next.
 *
 * ```ts
 * const cache = await createCache({
 *   persistence: { namespace: 'app', generation: 'user-42', debounceMs: 50 },
 * });
 * ```
 *
 * Hardening properties:
 *
 * * **One connection** — every operation reuses the promise of the single open; a
 *   `versionchange` from another tab closes it and the next operation reopens.
 * * **Corrupt rows cost one row each** — `load()` skips anything that is not a usable
 *   record instead of failing the whole restore.
 * * **Schema-stamped rows** — a newer schema resets the namespace (safe reset); older
 *   rows are migrated or skipped (see {@link SCHEMA_VERSION}).
 * * **Batched writes** — {@link CachePersistence.write} applies a whole flush in one
 *   transaction.
 *
 * Failures reject with a normal `Error` — `BlazeCache.create` catches them, warns, and keeps
 * running memory-only (private browsing modes routinely block IndexedDB).
 */
export function indexedDbPersistence(options: IndexedDbOptions = {}): CachePersistence {
  const database = options.database ?? DEFAULT_DATABASE;
  const store = options.store ?? DEFAULT_STORE;
  const baseNamespace = options.namespace ?? DEFAULT_NAMESPACE;
  let generation = options.generation ?? '';

  // `\0` is the separator of the composite key and of the generation fold — a namespace
  // containing one would make the isolation unparseable, so it fails loudly instead.
  if (typeof baseNamespace !== 'string' || baseNamespace.includes('\0')) {
    throw new RangeError(
      '[blaze-cache] persistence.namespace must be a string without a NUL character ("\\0").',
    );
  }
  if (typeof generation !== 'string' || generation.includes('\0')) {
    throw new RangeError(
      '[blaze-cache] persistence.generation must be a string without a NUL character ("\\0").',
    );
  }

  /**
   * The bucket every operation must use — the namespace, folded with the generation
   * when one is active. Every public method snapshots this **at entry**, so an
   * operation racing a {@link rotate} still completes inside the bucket it started in
   * and can never leak into the new generation.
   */
  let namespace = fold(baseNamespace, generation);

  const idFor = (ns: string, key: string): string => `${ns}\u0000${key}`;

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
        // Another tab can bump the database version at any moment; without a handler our
        // connection would block their `versionchange` event forever. Closing here keeps
        // the world coherent: `opening` only ever promises a *usable* connection, so the
        // next `open()` re-establishes one instead of handing out this closed zombie.
        const settled = opening;
        db.onversionchange = () => {
          db.close();
          if (opening === settled) opening = null;
        };
        // A forced close (browser eviction, `deleteDatabase` racing us) must equally
        // drop the cached connection, or every later operation would write into a
        // closed zombie and fail forever.
        db.onclose = () => {
          if (opening === settled) opening = null;
        };
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

  /**
   * Runs `body` inside one transaction, resolving when it commits.
   *
   * `body` receives a `fail(error)` helper for failures raised **asynchronously** — from
   * inside a request handler such as the `getAllKeys` continuation of a combined `write`.
   * Both it and a synchronous throw abort the transaction (rolling back every request
   * queued before the failure) and reject the caller with the original error; without the
   * abort an abandoned transaction would happily commit the half-applied batch.
   */
  const runTransaction = (
    db: IDBDatabase,
    mode: IDBTransactionMode,
    body: (objectStore: IDBObjectStore, fail: (error: unknown) => void) => void,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          tx.abort();
        } catch {
          // Already finished or already aborting — nothing to roll back.
        }
        reject(error);
      };
      try {
        body(tx.objectStore(store), fail);
      } catch (error) {
        fail(error);
        return;
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = () => {
        if (settled) return;
        settled = true;
        reject(tx.error ?? new Error('blaze-cache: IndexedDB transaction failed'));
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(tx.error ?? new Error('blaze-cache: IndexedDB transaction aborted'));
      };
    });

  const indexKeys = (db: IDBDatabase, ns: string): Promise<IDBValidKey[]> =>
    new Promise<IDBValidKey[]>((resolve, reject) => {
      const index = db.transaction(store, 'readonly').objectStore(store).index('ns');
      const request = index.getAllKeys(ns);
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error('blaze-cache: failed to read IndexedDB'));
    });

  const readAll = (db: IDBDatabase, ns: string): Promise<unknown[]> =>
    new Promise<unknown[]>((resolve, reject) => {
      const index = db.transaction(store, 'readonly').objectStore(store).index('ns');
      const request = index.getAll(ns);
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error('blaze-cache: failed to read IndexedDB'));
    });

  /** Applies one write batch — clear, then upserts, then deletes — in a single transaction. */
  const writeBatch = async ({ clear = false, save, remove }: PersistenceWriteOps): Promise<void> => {
    if (!clear && save.length === 0 && remove.length === 0) return;
    const ns = namespace; // snapshot: a rotate mid-flight must not redirect this batch
    const db = await open();
    await runTransaction(db, 'readwrite', (objectStore, fail) => {
      const apply = (): void => {
        for (const record of save) {
          objectStore.put({ ...record, id: idFor(ns, record.key), ns, v: SCHEMA_VERSION } satisfies StoredRecord);
        }
        for (const key of remove) objectStore.delete(idFor(ns, key));
      };
      if (!clear) {
        apply();
        return;
      }
      // Namespace-scoped clear inside the same transaction as the writes that follow it:
      // `objectStore.clear()` would wipe every cache sharing the store, and a second
      // transaction would split the batch's atomicity.
      const request = objectStore.index('ns').getAllKeys(ns);
      request.onsuccess = () => {
        try {
          for (const id of request.result ?? []) objectStore.delete(id);
          apply();
        } catch (error) {
          // Thrown inside a request handler, where `runTransaction`'s own try/catch can
          // no longer see it — abort explicitly or the earlier deletes would commit.
          fail(error);
        }
      };
    });
  };

  /** Empties this namespace only — one transaction. */
  const clearNamespace = (): Promise<void> => writeBatch({ clear: true, save: [], remove: [] });

  return {
    async load(): Promise<PersistedRecord[]> {
      const ns = namespace; // snapshot — see `writeBatch`
      const db = await open();
      const rows = await readAll(db, ns);

      // --- schema gate: one namespace, one schema -----------------------------
      let newer = false;
      for (const row of rows) {
        if (isRecord(row) && typeof row.v === 'number' && row.v > SCHEMA_VERSION) {
          newer = true;
          break;
        }
      }
      if (newer) {
        // Written by a newer package than this one: no migration can bridge *forward*,
        // and hydrating a shape we do not understand is worse than starting clean.
        // A cache is disposable by design — this is the safe-reset path.
        console.warn(
          `[blaze-cache] IndexedDB namespace was written by a newer schema — resetting it.`,
        );
        await clearNamespace();
        return [];
      }

      const records: PersistedRecord[] = [];
      let unreadable = 0;
      for (const row of rows) {
        try {
          if (!isRecord(row)) {
            // A row that is not even an object (a stray `put` from other code sharing
            // the store) costs exactly itself — never the rest of the restore.
            unreadable += 1;
            continue;
          }
          const from = row.v === undefined ? 0 : schemaVersionOf(row.v);
          if (from === null) {
            unreadable += 1;
            continue;
          }
          const source = from < SCHEMA_VERSION ? migrate(row, from) : row;
          if (source === null) {
            unreadable += 1;
            continue;
          }
          records.push({
            key: source.key as string,
            value: source.value,
            tags: (source.tags as string[] | undefined) ?? [],
            ttlMs: (source.ttlMs as number | null | undefined) ?? null,
            storedAt: (source.storedAt as number | undefined) ?? 0,
          });
        } catch {
          unreadable += 1;
        }
      }
      if (unreadable > 0) {
        console.warn(
          `[blaze-cache] skipping ${unreadable} unreadable persisted record(s) in namespace.`,
        );
      }
      return records;
    },

    async save(records: PersistedRecord[]): Promise<void> {
      if (records.length === 0) return;
      await writeBatch({ save: records, remove: [] });
    },

    async remove(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      await writeBatch({ save: [], remove: keys });
    },

    async clear(): Promise<void> {
      await clearNamespace();
    },

    async write(ops: PersistenceWriteOps): Promise<void> {
      await writeBatch(ops);
    },

    rotate(next: string): void {
      if (typeof next !== 'string' || next.includes('\0')) {
        throw new RangeError(
          '[blaze-cache] persistence.generation must be a string without a NUL character ("\\0").',
        );
      }
      // Switch buckets only — rows of the previous generation stay put (they are
      // invisible to the new one; `clear()` before rotating wipes them). Operations
      // already in flight keep the namespace they snapshotted, so a late write lands
      // in the old bucket rather than repopulating this one.
      generation = next;
      namespace = fold(baseNamespace, generation);
    },

    async keys(): Promise<string[]> {
      const ns = namespace; // snapshot — see `writeBatch`
      const db = await open();
      const ids = await indexKeys(db, ns);
      const prefix = `${ns}\u0000`;
      // The index hands back composite ids; strip the prefix to recover the cache keys, and
      // ignore anything that somehow lacks it rather than feeding nonsense to reconciliation.
      return ids.filter((id): id is string => typeof id === 'string' && id.startsWith(prefix))
        .map((id) => id.slice(prefix.length));
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

/** Folds a namespace and a generation into one bucket name (`namespace\0generation`). */
function fold(namespace: string, generation: string): string {
  return generation === '' ? namespace : `${namespace}\u0000${generation}`;
}

/** Narrowing a stored row to a plain object (anything else is corrupt). */
function isRecord(row: unknown): row is Record<string, unknown> {
  return typeof row === 'object' && row !== null;
}

/**
 * Validates a stored schema stamp: a non-negative integer, or `null` when the value is
 * present but unreadable (a corrupt stamp is not a version we can migrate from).
 */
function schemaVersionOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Walks the migration steps from `from` up to {@link SCHEMA_VERSION}; `null` = unusable. */
function migrate(
  row: Record<string, unknown>,
  from: number,
): Record<string, unknown> | null {
  let current: Record<string, unknown> | null = row;
  for (let version = from; version < SCHEMA_VERSION && current !== null; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) return null; // no known path from this version — treat it as unusable
    current = step(current);
  }
  return current;
}
