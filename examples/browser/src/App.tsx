import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlazeQuery } from '@blaze-cache/react-query';

import { api, cache, queryClient } from './blaze.js';

interface TodosPayload {
  items: string[];
  serverHits: number;
  fetchedAt: number;
}

async function fetchTodos(): Promise<TodosPayload> {
  const response = await api.get<TodosPayload>('/api/todos');
  // The adapter marks every response, so the UI can show what actually happened.
  const servedFromCache = response.headers['x-blaze-cache'] === 'HIT';
  return { ...response.data, serverHits: servedFromCache ? -1 : response.data.serverHits };
}

export default function App() {
  const client = useQueryClient();
  const todos = useBlazeQuery<TodosPayload>(cache, {
    queryKey: ['todos'],
    queryFn: fetchTodos,
    staleTime: 5_000,
  });

  const [serverHits, setServerHits] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (todos.data === undefined) return;
    let cancelled = false;
    void fetch('/api/__stats')
      .then((response) => response.json() as Promise<{ serverHits: number }>)
      .then((body) => {
        if (!cancelled) setServerHits(body.serverHits);
      });
    return () => {
      cancelled = true;
    };
  }, [todos.dataUpdatedAt]);

  const addTodo = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await api.post('/api/todos', { text });
    // Drop the cached HTTP response *and* tell TanStack to refetch.
    cache.invalidateTags('todos');
    await client.invalidateQueries({ queryKey: ['todos'] });
  };

  const stats = cache.stats();

  return (
    <main className="layout">
      <header>
        <h1>Blaze Cache</h1>
        <p>
          A WebAssembly cache with SIEVE eviction, TTLs, tags and IndexedDB persistence. Reload
          the page: the list paints instantly from storage, then revalidates in the background.
        </p>
      </header>

      <section className="panel">
        <h2>Todos</h2>
        {todos.isPending && <p className="muted">Loading…</p>}
        {todos.isError && <p className="error">{String(todos.error)}</p>}
        {todos.data && (
          <>
            <ul>
              {todos.data.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="muted">
              fetched at {new Date(todos.data.fetchedAt).toLocaleTimeString()}
              {serverHits !== null && ` · server hits: ${serverHits}`}
            </p>
          </>
        )}

        <div className="row">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addTodo();
            }}
            placeholder="new todo"
          />
          <button type="button" onClick={() => void addTodo()}>
            Add
          </button>
          <button type="button" onClick={() => void client.invalidateQueries({ queryKey: ['todos'] })}>
            Refetch
          </button>
          <button type="button" onClick={() => void queryClient.clear()}>
            Reset queries
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Cache statistics</h2>
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
          <button type="button" onClick={() => cache.prune()}>
            Prune expired
          </button>
          <button
            type="button"
            onClick={() => {
              cache.invalidateTags('todos');
              void queryClient.invalidateQueries({ queryKey: ['todos'] });
            }}
          >
            Invalidate “todos”
          </button>
          <button
            type="button"
            onClick={() => {
              cache.clear();
              void queryClient.clear();
            }}
          >
            Clear cache
          </button>
        </div>
      </section>
    </main>
  );
}
