import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const currentPath = () => window.location.hash.slice(1) || '/';
const entryKey = (): string => crypto.randomUUID();
const scrollRegion = () => document.documentElement.dataset.desktopScroll === 'true' ? document.querySelector<HTMLElement>('.workspace > main.container') : null;
const scrollTop = () => scrollRegion()?.scrollTop ?? window.scrollY;
const scrollTo = (top: number) => (scrollRegion() ?? window).scrollTo({ top, left: 0, behavior: 'instant' });

/** 新页面置顶；返回恢复各历史条目的位置，等待异步内容撑开页面。 */
export function useHashRoute() {
  const [route, setRoute] = useState(() => ({ path: currentPath(), top: 0, key: entryKey() }));
  const active = useRef(route);
  const positions = useRef(new Map<string, number>());
  const pagePositions = useRef(new Map<string, number>());
  const cursor = useRef(0);
  const entryIndexes = useRef(new Map<string, number>([[route.key, 0]]));
  const requestedReturn = useRef<string | null>(null);

  useEffect(() => {
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    window.history.replaceState({ ...window.history.state, tamScrollKey: active.current.key }, '');
    const save = () => {
      positions.current.set(active.current.key, scrollTop());
      pagePositions.current.set(active.current.path, scrollTop());
    };
    const change = () => {
      save();
      const path = currentPath();
      const storedKey = window.history.state?.tamScrollKey as string | undefined;
      const returning = storedKey && storedKey !== active.current.key && positions.current.has(storedKey);
      const top = returning ? positions.current.get(storedKey)! : requestedReturn.current === path ? pagePositions.current.get(path) ?? 0 : 0;
      requestedReturn.current = null;
      const key = returning ? storedKey : entryKey();
      cursor.current = returning ? entryIndexes.current.get(key) ?? 0 : cursor.current + 1;
      entryIndexes.current.set(key, cursor.current);
      window.history.replaceState({ ...window.history.state, tamScrollKey: key }, '');
      active.current = { path, top, key };
      setRoute(active.current);
    };
    window.addEventListener('scroll', save, { passive: true, capture: true });
    window.addEventListener('hashchange', change);
    return () => {
      window.removeEventListener('scroll', save, true);
      window.removeEventListener('hashchange', change);
      window.history.scrollRestoration = previousRestoration;
    };
  }, []);

  useLayoutEffect(() => {
    const top = route.top;
    scrollTo(top);
    if (!top) return;
    let frame = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(event, stop);
    };
    const restore = () => {
      if (stopped) return;
      scrollTo(top);
      const region = scrollRegion();
      if ((region ? region.scrollHeight - region.clientHeight : document.documentElement.scrollHeight - window.innerHeight) >= top) stop();
    };
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); });
    const mutations = new MutationObserver(() => {
      if (stopped) return;
      for (const child of scrollRegion()?.children ?? []) observer.observe(child);
      cancelAnimationFrame(frame); frame = requestAnimationFrame(restore);
    });
    const timeout = setTimeout(stop, 5000);
    observer.observe(document.body);
    if (scrollRegion()) mutations.observe(scrollRegion()!, { childList: true, subtree: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, stop, { passive: true });
    frame = requestAnimationFrame(restore);
    return stop;
  }, [route]);

  const navigate = useCallback((to: string, options?: { restoreScroll?: boolean }) => {
    if (to === currentPath()) return;
    requestedReturn.current = options?.restoreScroll ? to : null;
    window.location.hash = to;
  }, []);
  const back = useCallback((fallback: string) => {
    if (cursor.current > 0) window.history.back();
    else navigate(fallback, { restoreScroll: true });
  }, [navigate]);
  return { path: route.path, navigate, back };
}
