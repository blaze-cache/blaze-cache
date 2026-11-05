import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateBlazeQueries, useBlazeMutation, useBlazeQuery } from '@blaze-cache/react-query';

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

/** Read the fake server's counter without going through TanStack or the mirror. */
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
  const client = useQueryClient();
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
  const queryFn = useCallback(async () => {
    const started = performance.now();
    try {
      const payload = await fetchTodosPayload();
      pushLog({
        marker: 'SYNC',
        ms: performance.now() - started,
        url: 'GET /api/todos',
        note: 'network fetch — mirror refilled',
      });
      return payload;
    } catch (error) {
      pushLog({
        marker: 'ERR',
        ms: performance.now() - started,
        url: 'GET /api/todos',
        note: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, [pushLog]);

  const todos = useBlazeQuery(cache, {
    queryKey: ['todos'],
    queryFn,
    staleTime: 5_000,
  });

  const addTodo = useBlazeMutation(cache, {
    mutationFn: async (text: string) => {
      const started = performance.now();
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`POST /api/todos failed with ${response.status}`);
      pushLog({
        marker: 'LOG',
        ms: performance.now() - started,
        url: 'POST /api/todos',
        note: 'never mirrored',
      });
      return response.json() as Promise<{ ok: boolean }>;
    },
    invalidate: { queryKey: ['todos'], tags: ['todos'] },
  });

  useEffect(() => {
    if (todos.data === undefined) return;
    let cancelled = false;
    void readServerHits().then((hits) => {
      if (!cancelled) setServerHits(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [todos.dataUpdatedAt, todos.data]);

  const stats = useMemo(() => cache.stats(), [statsVersion]);
  const fetchedAt = todos.data ? new Date(todos.data.fetchedAt).toLocaleTimeString() : null;
  const badgeText = todos.isFetching ? 'revalidating' : todos.data ? 'persisted' : 'idle';
  const badgeClass = todos.isFetching
    ? 'badge badge-miss'
    : todos.data
      ? 'badge badge-hit'
      : 'badge badge-idle';

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    addTodo.mutate(text);
  };

  const invalidateTodos = async () => {
    await invalidateBlazeQueries(cache, client, { queryKey: ['todos'], tags: ['todos'] });
    pushLog({
      marker: 'LOG',
      ms: 0,
      url: "invalidateBlazeQueries({ queryKey: ['todos'], tags: ['todos'] })",
      note: 'TanStack marked stale, mirror purged',
    });
    setStatsVersion((version) => version + 1);
  };

  const runCacheOp = (label: string, note: string) => {
    pushLog({ marker: 'LOG', ms: 0, url: label, note });
    setStatsVersion((version) => version + 1);
  };

  return (
    <main className="layout">
      <header>
        <h1>Blaze Cache × TanStack Query</h1>
        <p>
          TanStack Query v5 mirrored into WebAssembly. Successful fetches are persisted with
          their original <code>dataUpdatedAt</code>, so a reload paints instantly from the
          mirror while the query refetches in the background — exactly the stale-while-revalidate
          you already know.
        </p>
      </header>

      <section className="panel" aria-labelledby="todos-title">
        <h2 id="todos-title">
          Todos <span className={badgeClass}>{badgeText}</span>
        </h2>

        {todos.isPending && !todos.data && <p className="muted">Loading…</p>}
        {todos.isError && <p className="error">{String(todos.error)}</p>}
        {todos.data && (
          <ul>
            {todos.data.items.map((item, index) => (
              <li key={`${index}:${item}`}>{item}</li>
            ))}
          </ul>
        )}

        <p className="muted">
          {fetchedAt ? `fetched at ${fetchedAt}` : 'no fetch yet'}
          {serverHits !== null && ` · server hits: ${serverHits}`}
          {todos.isFetching && ' · revalidating…'}
        </p>

        <div className="row">
          <input
            type="text"
            value={draft}
            placeholder="new todo"
            aria-label="new todo"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitDraft();
            }}
          />
          <button
            type="button"
            onClick={submitDraft}
            disabled={addTodo.isPending || !draft.trim()}
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => void client.invalidateQueries({ queryKey: ['todos'] })}
          >
            Refetch
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
          Renders read the mirror with <code>peek</code>, so they don’t move the hit rate — the
          counters below only see imperative reads and writes.
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
              runCacheOp('cache.clear()', 'mirror purged (TanStack snapshot untouched)');
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
