import { useEffect, useMemo, useRef, useState } from 'react';

import { createExampleCache } from './blaze.js';
import type { ExampleStorage } from './blaze.js';
import type { BlazeCache, CacheEvent } from '@blaze-cache/core';

interface EventLine {
  id: number;
  time: string;
  text: string;
}

function describe(event: CacheEvent<string>): string {
  switch (event.type) {
    case 'set':
      return `set ${event.key}`;
    case 'touch':
      return `touch ${event.key}`;
    case 'delete':
      return `delete ${event.key}`;
    case 'clear':
      return 'clear';
    case 'invalidate':
      return `invalidate ${event.keys.length} entr${event.keys.length === 1 ? 'y' : 'ies'} → ${event.keys.join(', ')}`;
    case 'prune':
      return `prune ${event.keys.length} expired → ${event.keys.join(', ')}`;
    case 'evict':
      return `evict ${event.key}`;
    case 'expire':
      return `expire ${event.key}`;
    case 'hit':
      return `hit ${event.key}`;
    case 'miss':
      return `miss ${event.key}`;
    case 'remote-set':
      return `remote set ${event.key}`;
    case 'remote-delete':
      return `remote delete ${event.key}`;
    case 'remote-clear':
      return 'remote clear';
    case 'remote-invalidate':
      return 'remote invalidate';
    case 'remote-rotate':
      return 'remote rotate';
  }
}

const truncate = (value: string, limit = 48): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

export default function App() {
  // The cache is recreated when the storage mode changes: values move between the Rust slab
  // and a JS Map, so a fresh instance (and its own persistence namespace) is the only honest
  // way to show what each mode owns.
  const [storage, setStorage] = useState<ExampleStorage>(() =>
    new URLSearchParams(window.location.search).get('storage') === 'js' ? 'js' : 'wasm',
  );
  const [cache, setCache] = useState<BlazeCache<string> | null>(null);
  const [keyInput, setKeyInput] = useState('greeting');
  const [valueInput, setValueInput] = useState('hello from Blaze Cache');
  const [ttlInput, setTtlInput] = useState('30000');
  const [tagsInput, setTagsInput] = useState('demo');
  const [tagInput, setTagInput] = useState('demo');
  const [lookup, setLookup] = useState('(nothing read yet)');
  const [log, setLog] = useState<EventLine[]>([]);
  const [statsVersion, setStatsVersion] = useState(0);
  const [entriesVersion, setEntriesVersion] = useState(0);
  const idRef = useRef(0);

  const pushLog = (text: string) => {
    idRef.current += 1;
    const line = { id: idRef.current, time: new Date().toLocaleTimeString(), text };
    setLog((previous) => [line, ...previous].slice(0, 20));
  };

  const refresh = () => {
    setStatsVersion((version) => version + 1);
    setEntriesVersion((version) => version + 1);
  };

  const stats = useMemo(
    () => cache?.stats() ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, statsVersion],
  );
  const entries = useMemo(
    () => cache?.entries().slice(0, 25) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, entriesVersion],
  );

  useEffect(() => {
    let active = true;
    let off: (() => void) | undefined;
    const pending = createExampleCache(storage);
    void pending.then((next) => {
      if (!active) {
        void next.dispose();
        return;
      }
      off = next.on((event) => {
        pushLog(describe(event));
        refresh();
      });
      setCache(next);
      pushLog(`storage: ${storage === 'js' ? 'js (values in a JS Map)' : 'wasm (values in the Rust slab)'}`);
      refresh();
    });
    return () => {
      active = false;
      off?.();
      void pending.then((next) => next.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  const parsedTtl = (): number | null | undefined => {
    const raw = ttlInput.trim();
    if (raw === '') return undefined; // no TTL input → keep default? we treat empty as "no expiry"
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };

  const parseTags = (raw: string) =>
    raw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);

  const setEntry = () => {
    if (!cache) return;
    const key = keyInput.trim();
    if (!key) {
      pushLog('set skipped: key is empty');
      return;
    }
    const ttl = parsedTtl();
    if (ttl === null) {
      pushLog('set skipped: ttl must be a finite number ≥ 0 (ms), or empty for no expiry');
      return;
    }
    const tags = parseTags(tagsInput);
    cache.set(key, valueInput, ttl === undefined ? { tags } : { ttlMs: ttl, tags });
    setLookup(`set ${key}`);
    refresh();
  };

  const getEntry = () => {
    if (!cache) return;
    const key = keyInput.trim();
    const value = cache.get(key);
    setLookup(value === undefined ? `miss: ${key}` : value);
    refresh();
  };

  const deleteEntry = () => {
    if (!cache) return;
    const key = keyInput.trim();
    setLookup(cache.delete(key) ? `deleted ${key}` : `not found: ${key}`);
    refresh();
  };

  const invalidateTag = () => {
    if (!cache) return;
    const tag = tagInput.trim();
    if (!tag) {
      pushLog('invalidate skipped: tag is empty');
      return;
    }
    const removed = cache.invalidateTags(tag);
    pushLog(`invalidate “${tag}” → ${removed.length} removed`);
    refresh();
  };

  return (
    <main className="layout">
      <header>
        <h1>Blaze Cache — core playground</h1>
        <p>
          A WebAssembly cache with SIEVE eviction, TTLs, tags and IndexedDB persistence. Write
          entries, read them back, watch events, then reload — everything under the{' '}
          <code>blaze-example-core-&lt;storage&gt;</code> namespace comes back from storage.
        </p>
        <div className="row" aria-label="value storage mode">
          <span className="muted">value storage</span>
          <button
            type="button"
            aria-pressed={storage === 'wasm'}
            disabled={storage === 'wasm'}
            onClick={() => setStorage('wasm')}
          >
            wasm (default)
          </button>
          <button
            type="button"
            aria-pressed={storage === 'js'}
            disabled={storage === 'js'}
            onClick={() => setStorage('js')}
          >
            js (hybrid)
          </button>
          <span className="muted">
            {storage === 'js'
              ? 'values live in a JS Map; Wasm keeps keys, TTL, tags and stable ids'
              : 'values are by-reference externrefs held in the Rust slab'}
          </span>
        </div>
      </header>

      <section className="panel" aria-labelledby="editor-title">
        <h2 id="editor-title">Entries</h2>
        <div className="field-grid">
          <label>
            key
            <input value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
          </label>
          <label>
            value
            <input value={valueInput} onChange={(event) => setValueInput(event.target.value)} />
          </label>
          <label>
            ttl (ms, empty = no expiry)
            <input value={ttlInput} onChange={(event) => setTtlInput(event.target.value)} />
          </label>
          <label>
            tags (comma separated)
            <input value={tagsInput} onChange={(event) => setTagsInput(event.target.value)} />
          </label>
        </div>
        <div className="row">
          <button type="button" onClick={setEntry}>
            Set
          </button>
          <button type="button" onClick={getEntry}>
            Get
          </button>
          <button type="button" onClick={deleteEntry}>
            Delete
          </button>
        </div>
        <p className="muted lookup" aria-live="polite">
          {lookup}
        </p>

        <table className="entries">
          <thead>
            <tr>
              <th>key</th>
              <th>value</th>
              <th>ttl left</th>
              <th>tags</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  empty — set something, or reload after setting something
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.key}>
                <td>{entry.key}</td>
                <td>{truncate(String(entry.value))}</td>
                <td>{entry.ttlMs === null ? '∞' : `${Math.max(0, Math.round(entry.ttlMs / 100) / 10)}s`}</td>
                <td>{entry.tags.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel" aria-labelledby="invalidate-title">
        <h2 id="invalidate-title">Tags</h2>
        <div className="row">
          <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} aria-label="tag to invalidate" />
          <button type="button" onClick={invalidateTag}>
            Invalidate tag
          </button>
          <button type="button" onClick={() => { if (!cache) return; const removed = cache.prune(); pushLog(`prune → ${removed.length} expired`); refresh(); }}>
            Prune expired
          </button>
          <button type="button" onClick={() => { if (!cache) return; cache.clear(); setLookup('cache cleared'); refresh(); }}>
            Clear cache
          </button>
        </div>
        <div className="row">
          <button type="button" onClick={() => { if (!cache) return; cache.resetStats(); refresh(); }}>
            Reset stats
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="stats-title">
        <h2 id="stats-title">Cache statistics</h2>
        <dl className="stats">
          <dt>hits</dt>
          <dd>{stats?.hits ?? 0}</dd>
          <dt>misses</dt>
          <dd>{stats?.misses ?? 0}</dd>
          <dt>hit rate</dt>
          <dd>{((stats?.hitRate ?? 0) * 100).toFixed(0)}%</dd>
          <dt>entries</dt>
          <dd>
            {stats?.size ?? 0} / {stats?.capacity ?? 0}
          </dd>
          <dt>evictions</dt>
          <dd>{stats?.evictions ?? 0}</dd>
          <dt>expirations</dt>
          <dd>{stats?.expirations ?? 0}</dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="events-title">
        <h2 id="events-title">Event log</h2>
        <ol className="log" aria-live="polite" aria-label="cache events">
          {log.map((line) => (
            <li key={line.id}>
              <span>{line.time}</span>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
