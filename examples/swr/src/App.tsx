import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlazeSWR } from '@blaze-cache/swr';

import { cache, fetchTodosPayload } from './blaze.js';

type LogMarker = 'SYNC' | 'ERR' | 'LOG';

interface LogEntry {
  id: number;
  time: string;
  ms: number;
  marker: LogMarker;
  url: string;
  note?: string;
}

/** Read the fake server's counter without going through SWR or the mirror. */
async function readServerHits(): Promise<number | null> {
  try {
    const response = await fetch('/api/__stats', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { serverHits?: number };
    return typeof body.serverHits === 'number' ? body.serverHits : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [draft, setDraft] = useState('');
  const [serverHits, setServerHits] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [statsVersion, setStatsVersion] = useState(0);
  const logId = useRef(0);

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'time'>) => {
    logId.current += 1;
    const next: LogEntry = {
      ...entry,
      id: logId.current,
      time: new Date().toLocaleTimeString(),
    };
    setLog((previous) => [next, ...previous].slice(0, 12));
  }, []);

  // Every real network read goes through this, so the log shows what the mirror hides.
  const fetcher = useCallback(
    async (url: string) => {
      const started = performance.now();
      try {
        const payload = await fetchTodosPayload();
        pushLog({
          marker: 'SYNC',
          ms: performance.now() - started,
          url: `GET ${url}`,
          note: 'network fetch — mirror refilled',
        });
        return payload;
      } catch (error) {
        pushLog({
          marker: 'ERR',
          ms: performance.now() - started,
          url: `GET ${url}`,
          note: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [pushLog],
  );

  const { data, error, isLoading, isValidating, mutate } = useBlazeSWR(
    cache,
    '/api/todos',
    fetcher,
    { ttlMs: 24 * 60 * 60_000, tags: ['swr', 'todos'] },
  );

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    void readServerHits().then((hits) => {
      if (!cancelled) setServerHits(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const stats = useMemo(() => cache.stats(), [statsVersion]);
  const fetchedAt = data ? new Date(data.fetchedAt).toLocaleTimeString() : null;
  const badgeText = isLoading ? 'loading' : isValidating ? 'revalidating' : data ? 'persisted' : 'idle';
  const badgeClass = isValidating
    ? 'badge badge-miss'
    : data
      ? 'badge badge-hit'
      : 'badge badge-idle';

  const submitDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const started = performance.now();
    const response = await fetch('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      pushLog({
        marker: 'ERR',
        ms: performance.now() - started,
        url: 'POST /api/todos',
        note: `failed with ${response.status}`,
      });
      return;
    }
    pushLog({
      marker: 'LOG',
      ms: performance.now() - started,
      url: 'POST /api/todos',
      note: 'never mirrored',
    });
    // Drop the persisted copies, then revalidate the mounted hook.
    cache.invalidateTags('todos');
    await mutate();
    setStatsVersion((version) => version + 1);
  };

  const invalidateTodos = async () => {
    const removed = cache.invalidateTags('todos');
    pushLog({
      marker: 'LOG',
      ms: 0,
      url: "cache.invalidateTags('todos')",
      note: `purged ${removed.length} persisted entr${removed.length === 1 ? 'y' : 'ies'}`,
    });
    await mutate();
    setStatsVersion((version) => version + 1);
  };

  const runCacheOp = (label: string, note: string) => {
    pushLog({ marker: 'LOG', ms: 0, url: label, note });
    setStatsVersion((version) => version + 1);
  };

  return (
    <main className="layout">
      <header>
        <h1>Blaze Cache × SWR</h1>
        <p>
          SWR seeded from WebAssembly. The persisted list is handed to SWR as{' '}
          <code>fallbackData</code>, so a reload paints instantly while SWR revalidates in the
          background — like plain <code>useSWR</code>, but the data survives the session.
        </p>
      </header>

      <section className="panel" aria-labelledby="todos-title">
        <h2 id="todos-title">
          Todos <span className={badgeClass}>{badgeText}</span>
        </h2>

        {isLoading && !data && <p className="muted">Loading…</p>}
        {error && <p className="error">{String(error)}</p>}
        {data && (
          <ul>
            {data.items.map((item, index) => (
              <li key={`${index}:${item}`}>{item}</li>
            ))}
          </ul>
        )}

        <p className="muted">
          {fetchedAt ? `fetched at ${fetchedAt}` : 'no fetch yet'}
          {serverHits !== null && ` · server hits: ${serverHits}`}
          {isValidating && ' · revalidating…'}
        </p>

        <div className="row">
          <input
            type="text"
            value={draft}
            placeholder="new todo"
            aria-label="new todo"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitDraft();
            }}
          />
          <button type="button" onClick={() => void submitDraft()} disabled={!draft.trim()}>
            Add
          </button>
          <button type="button" onClick={() => void mutate()}>
            Revalidate
          </button>
          <button type="button" onClick={() => void invalidateTodos()}>
            Invalidate “todos”
          </button>
        </div>

        <ol className="log" aria-live="polite" aria-label="request log">
          {log.map((entry) => (
            <li key={entry.id}>
              <span className={entry.marker === 'ERR' ? 'miss' : 'hit'}>{entry.marker}</span>
              <span>
                {entry.time} · {String(Math.round(entry.ms)).padStart(4)} ms · {entry.url}
                {entry.note ? ` — ${entry.note}` : ''}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" aria-labelledby="stats-title">
        <h2 id="stats-title">Mirror statistics</h2>
        <p className="muted">
          SWR owns freshness within a session; Blaze owns it across sessions. Reads here prefer{' '}
          <code>peek</code>, so rendering doesn’t move the hit rate.
        </p>
        <dl className="stats">
          <dt>hits</dt>
          <dd>{stats.hits}</dd>
          <dt>misses</dt>
          <dd>{stats.misses}</dd>
          <dt>hit rate</dt>
          <dd>{(stats.hitRate * 100).toFixed(0)}%</dd>
          <dt>entries</dt>
          <dd>
            {stats.size} / {stats.capacity}
          </dd>
          <dt>evictions</dt>
          <dd>{stats.evictions}</dd>
          <dt>expirations</dt>
          <dd>{stats.expirations}</dd>
        </dl>
        <div className="row">
          <button
            type="button"
            onClick={() => runCacheOp('cache.prune()', `dropped ${cache.prune().length} expired`)}
          >
            Prune expired
          </button>
          <button
            type="button"
            onClick={() => {
              cache.clear();
              runCacheOp('cache.clear()', 'mirror purged (SWR snapshot untouched)');
            }}
          >
            Clear mirror
          </button>
          <button
            type="button"
            onClick={() => {
              cache.resetStats();
              setStatsVersion((version) => version + 1);
            }}
          >
            Reset stats
          </button>
        </div>
      </section>
    </main>
  );
}
