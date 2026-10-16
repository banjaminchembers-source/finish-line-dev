import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { lovable } from '@/integrations/lovable/index';

export type SyncEntry = { id: string; role: string; content: string; time: number; localOnly?: boolean };
export type SyncThread = { id: string; title: string; messages: SyncEntry[]; updatedAt: number };
type Store = { threads: SyncThread[]; currentId: string };

export function useAuthUser() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_e, session) => { setUser(session?.user ?? null); setReady(true); });
    void supabase.auth.getSession().then(({ data: d }) => { setUser(d.session?.user ?? null); setReady(true); });
    const fallback = setTimeout(() => setReady(true), 1500);
    return () => { clearTimeout(fallback); data.subscription.unsubscribe(); };
  }, []);
  return { user, ready };
}

export async function signInWithGoogle(): Promise<string | null> {
  const result = await lovable.auth.signInWithOAuth('google', { redirect_uri: window.location.origin });
  if (result.error) return 'Не удалось войти через Google. Попробуйте ещё раз.';
  return null;
}

export async function signOut() { await supabase.auth.signOut(); }

/** Merges two thread lists by id; the more recently updated copy wins. */
export function mergeThreads(local: SyncThread[], remote: SyncThread[]): SyncThread[] {
  const map = new Map<string, SyncThread>();
  for (const t of [...local, ...remote]) {
    const prev = map.get(t.id);
    if (!prev || t.updatedAt > prev.updatedAt) map.set(t.id, t);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Keeps conversations in the signed-in user's account. */
export function useCloudSync<S extends Store>(userId: string | null, state: S, setState: (fn: (s: S) => S) => void) {
  const [syncState, setSyncState] = useState<'idle' | 'loading' | 'saved' | 'error'>('idle');
  const syncedRef = useRef<Map<string, number>>(new Map());
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) { loadedFor.current = null; syncedRef.current = new Map(); setSyncState('idle'); return; }
    if (loadedFor.current === userId) return;
    let cancelled = false;
    setSyncState('loading');
    void supabase.from('conversations').select('id,title,messages,updated_at').then(({ data, error }) => {
      if (cancelled) return;
      if (error) { setSyncState('error'); return; }
      const remote: SyncThread[] = (data ?? []).map((r) => ({
        id: r.id, title: r.title, messages: (Array.isArray(r.messages) ? r.messages : []) as SyncEntry[],
        updatedAt: new Date(r.updated_at).getTime(),
      }));
      syncedRef.current = new Map(remote.map((t) => [t.id, t.updatedAt]));
      loadedFor.current = userId;
      setState((s) => {
        const threads = mergeThreads(s.threads.filter((t) => t.messages.length || t.id === s.currentId), remote) as S['threads'];
        return { ...s, threads, currentId: threads.some((t) => t.id === s.currentId) ? s.currentId : threads[0]!.id };
      });
      setSyncState('saved');
    });
    return () => { cancelled = true; };
  }, [userId, setState]);

  useEffect(() => {
    if (!userId || loadedFor.current !== userId) return;
    const timer = setTimeout(async () => {
      const synced = syncedRef.current;
      const changed = state.threads.filter((t) => t.messages.length && synced.get(t.id) !== t.updatedAt);
      const present = new Set(state.threads.filter((t) => t.messages.length).map((t) => t.id));
      const removed = [...synced.keys()].filter((id) => !present.has(id));
      if (!changed.length && !removed.length) return;
      let failed = false;
      if (changed.length) {
        const { error } = await supabase.from('conversations').upsert(changed.map((t) => ({
          id: t.id, user_id: userId, title: t.title,
          messages: t.messages.filter((m) => !m.localOnly) as never,
          updated_at: new Date(t.updatedAt).toISOString(),
        })), { onConflict: 'user_id,id' });
        if (error) failed = true; else changed.forEach((t) => synced.set(t.id, t.updatedAt));
      }
      if (removed.length) {
        const { error } = await supabase.from('conversations').delete().in('id', removed);
        if (error) failed = true; else removed.forEach((id) => synced.delete(id));
      }
      setSyncState(failed ? 'error' : 'saved');
    }, 700);
    return () => clearTimeout(timer);
  }, [userId, state]);

  return syncState;
}
