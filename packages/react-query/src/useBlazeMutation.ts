import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DefaultError, UseMutationOptions, UseMutationResult } from '@tanstack/react-query';

import { invalidateBlazeQueries } from './imperative.js';
import type { BlazeQueryCacheLike, BlazeQueryFilters } from './types.js';

/**
 * The options {@link useBlazeMutation} accepts: TanStack's own `UseMutationOptions` —
 * everything you can pass to `useMutation` — plus declarative, **two-sided** invalidation.
 */
export interface BlazeMutationOptions<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TContext = unknown,
> extends UseMutationOptions<TData, TError, TVariables, TContext> {
  /**
   * Queries invalidated after a successful mutation, one filter or an array of them —
   * each applied through {@link invalidateBlazeQueries}, so TanStack marks them stale
   * (active ones refetch) **and** the matching persisted records are purged.
   *
   * Runs after your own `onSuccess`, awaited in order, so callback side effects (writes,
   * navigation) land before anything is invalidated — and a throwing `onSuccess` skips
   * the invalidation exactly like it skips TanStack's own refetch chain.
   *
   * ```ts
   * const addTodo = useBlazeMutation(cache, {
   *   mutationFn: (text: string) => api.addTodo(text),
   *   invalidate: { queryKey: ['todos'] },
   * });
   * ```
   *
   * Omit it to keep invalidation entirely in your own `onSuccess`/`onSettled` — those are
   * untouched when no `invalidate` is given.
   */
  invalidate?: BlazeQueryFilters | BlazeQueryFilters[];
}

/**
 * `useMutation` whose success path keeps the Blaze Cache mirror in step.
 *
 * Apart from the optional {@link BlazeMutationOptions.invalidate} — TanStack-side
 * invalidation plus mirror purge through {@link invalidateBlazeQueries} — this is
 * `useMutation` verbatim: same generics, same result type, same per-call callbacks, and
 * your hook-level callbacks run first when both are present.
 *
 * ```tsx
 * function AddTodo({ userId }: { userId: string }) {
 *   const addTodo = useBlazeMutation(cache, {
 *     mutationFn: (text: string) => api.addTodo(userId, text),
 *     invalidate: [
 *       { queryKey: ['todos', userId] },
 *       { tags: ['todos', `user:${userId}`] },
 *     ],
 *     onSuccess: () => toast('Added'),
 *   });
 *   // addTodo.mutate('Buy milk') — 'Added' toasts, then both filters invalidate
 * }
 * ```
 *
 * Requires a `QueryClientProvider` above it, exactly like `useMutation`.
 */
export function useBlazeMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TContext = unknown,
>(
  cache: BlazeQueryCacheLike,
  options: BlazeMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const client = useQueryClient();

  // Without `invalidate` there is nothing to compose — pass the caller's options through
  // untouched, so `onSuccess` semantics are byte-for-byte TanStack's.
  if (options.invalidate === undefined) {
    return useMutation<TData, TError, TVariables, TContext>(options, client);
  }

  const { invalidate, onSuccess, ...mutationOptions } = options;

  return useMutation<TData, TError, TVariables, TContext>(
    {
      ...mutationOptions,
      onSuccess: async (data, variables, onMutateResult, context) => {
        // Caller first: their `onSuccess` writes/navigation happen before invalidation,
        // and if it throws, no invalidation runs — mirroring how TanStack treats a
        // throwing `onSuccess` by abandoning the rest of its success chain.
        if (onSuccess) await onSuccess(data, variables, onMutateResult, context);
        const filters = Array.isArray(invalidate) ? invalidate : [invalidate];
        for (const filter of filters) {
          await invalidateBlazeQueries(cache, client, filter);
        }
      },
    },
    client,
  );
}
