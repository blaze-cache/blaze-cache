import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { blazeFetch, cache } from './blaze.js';

interface TodosPayload {
  items: string[];
  serverHits: number;
  fetchedAt: number;
}

type LogMarker = 'HIT' | 'MISS' | 'STALE' | 'ERR' | 'LOG';
type BadgeMarker = Exclude<LogMarker, 'LOG'> | 'idle';

interface LogEntry {
  id: number;
  time: string;
  ms: number;
  marker: LogMarker;
  url: string;
  note?: string;
}

/** Read the fake server's counter without going through the cache. */
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

function markerFrom(response: Response): Exclude<BadgeMarker, 'idle'> {
  const raw = response.headers.get('x-blaze-cache');
  return raw === 'HIT' || raw === 'STALE' ? raw : 'MISS';
}

export default function App() {
  const [todos, setTodos] = useState<TodosPayload | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [marker, setMarker] = useState<BadgeMarker>('idle');
  const [serverHits, setServerHits] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [statsVersion, setStatsVersion] = useState(0);
  const logId = useRef(0);
  const initialFetch = useRef(false);

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'time'>) => {
    logId.current += 1;
    const next: LogEntry = {
      ...entry,
      id: logId.current,
      time: new Date().toLocaleTimeString(),
    };
    setLog((previous) => [next, ...previous].slice(0, 12));
  }, []);

  const refresh = useCallback(
    async (reason: 'load' | 'manual' | 'after-add' = 'manual') => {
      setLoading(true);
      const started = performance.now();
      try {
        const response = await blazeFetch('/api/todos');
        const nextMarker = markerFrom(response);
        const data = (await response.json()) as TodosPayload;
        const ms = performance.now() - started;

        setTodos(data);
        setMarker(nextMarker);
        pushLog({
          marker: nextMarker,
          ms,
          url: '/api/todos',
          note: reason === 'load' ? 'initial load' : undefined,
        });

        setServerHits(await readServerHits());
      } catch (error) {
        const ms = performance.now() - started;
        setMarker('ERR');
        pushLog({
          marker: 'ERR',
          ms,
          url: '/api/todos',
          note: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setLoading(false);
        setStatsVersion((version) => version + 1);
      }
    },
    [pushLog],
  );

  useEffect(() => {
    if (initialFetch.current) return;
    initialFetch.current = true;
    void refresh('load');
  }, [refresh]);

  const stats = useMemo(() => cache.stats(), [statsVersion]);

  const addTodo = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setAdding(true);
    const started = performance.now();
    try {
      const response = await blazeFetch('/api/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`POST /api/todos failed with ${response.status}`);
      pushLog({
        marker: 'LOG',
        ms: performance.now() - started,
        url: 'POST /api/todos',
        note: 'never cached',
      });
    } catch (error) {
      pushLog({
        marker: 'ERR',
        ms: performance.now() - started,
        url: 'POST /api/todos',
        note: error instanceof Error ? error.message : String(error),
      });
      setAdding(false);
      return;
    }
    cache.invalidateTags('fetch');
    await refresh('after-add');
    setAdding(false);
  };

  const runCacheOp = (label: string, note: string) => {
    pushLog({ marker: 'LOG', ms: 0, url: label, note });
    setStatsVersion((version) => version + 1);
  };

  const badgeClass =
    marker === 'HIT'
      ? 'badge badge-hit'
      : marker === 'MISS'
        ? 'badge badge-miss'
        : marker === 'STALE'
          ? 'badge badge-stale'
          : 'badge badge-idle';
  const badgeText = marker === 'ERR' ? 'error' : marker;
  const fetchedLine =
    todos === null
      ? 'no fetch yet'
      : `fetched at ${new Date(todos.fetchedAt).toLocaleTimeString()}`;

  return (
    <main className="layout">
      <header>
        <h1>Blaze Cache × fetch</h1>
        <p>
          A drop-in <code>fetch</code> backed by WebAssembly: TTLs, tags, <code>Cache-Control</code>
          support and IndexedDB persistence. Every read pays 400&nbsp;ms on a MISS and is instant
          on a HIT.
        </p>
      </header>

      <section className="panel" aria-labelledby="todos-title">
        <h2 id="todos-title">
          Todos <span className={badgeClass}>{badgeText}</span>
        </h2>

        {todos === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul>
            {todos.items.map((item, index) => (
              <li key={`${index}:${item}`}>{item}</li>
            ))}
          </ul>
        )}

        <p className="muted">
          <span>{fetchedLine}</span>
          {serverHits !== null && ` · server hits: ${serverHits}`}
        </p>

        <div className="row">
          <input
            type="text"
            value={draft}
            placeholder="new todo"
            aria-label="new todo"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addTodo();
            }}
          />
          <button type="button" onClick={() => void addTodo()} disabled={adding || !draft.trim()}>
            Add
          </button>
          <button type="button" onClick={() => void refresh('manual')} disabled={loading}>
            Refresh
          </button>
        </div>

        <ol className="log" aria-live="polite" aria-label="request log">
          {log.map((entry) => (
            <li key={entry.id}>
              <span
                className={
                  entry.marker === 'HIT'
                    ? 'hit'
                    : entry.marker === 'MISS'
                      ? 'miss'
                      : entry.marker === 'STALE'
                        ? 'stale'
                        : ''
                }
              >
                {entry.marker.padEnd(5)}
              </span>
              <span>
                {entry.time} · {String(Math.round(entry.ms)).padStart(4)} ms · {entry.url}
                {entry.note ? ` — ${entry.note}` : ''}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" aria-labelledby="stats-title">
        <h2 id="stats-title">Cache statistics</h2>
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
            onClick={() =>
              runCacheOp("cache.invalidateTags('fetch')", `dropped ${cache.invalidateTags('fetch').length} entries`)
            }
          >
            Invalidate “fetch”
          </button>
          <button
            type="button"
            onClick={() => {
              cache.clear();
              runCacheOp('cache.clear()', 'all entries dropped');
            }}
          >
            Clear cache
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
