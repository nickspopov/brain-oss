import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api/client';
import type { SessionPrincipal } from './api/types';

export const SESSION_KEY = ['session'] as const;

/** The currently signed-in human, or `null`. */
export async function fetchSession(): Promise<SessionPrincipal | null> {
  try {
    return (await api.session()).principal;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unauthenticated') return null;
    throw err;
  }
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: Infinity, retry: false });
}
