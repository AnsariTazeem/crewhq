import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiError, read } from "./api";
import type { LiveConnection } from "./live";

export const LiveContext = createContext<LiveConnection | null>(null);
export const ActorContext = createContext<{
  id: string;
  changed: () => void;
} | null>(null);
const idle = {
  phase: "connecting" as const,
  generation: null,
  frontier: null,
  revision: 0,
  reset: 0,
};
const idleSubscribe = () => () => {};
const idleSnapshot = () => idle;
export function useLive() {
  const live = useContext(LiveContext);
  return useSyncExternalStore(
    live?.subscribe ?? idleSubscribe,
    live?.getSnapshot ?? idleSnapshot,
  );
}
export type Query<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  stale: boolean;
  reload: () => void;
};
export function useQuery<T>(path: string | null, liveRead = true): Query<T> {
  const live = useContext(LiveContext);
  const actor = useContext(ActorContext);
  const snapshot = useLive();
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    error: unknown;
    revision: number;
  }>({ path: null, data: null, error: null, revision: -1 });
  const [reload, setReload] = useState(0);
  const appliedReset = useRef(-1);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let stopped = false;
    let running = false;
    let dirty = true;
    const run = async () => {
      if (running || stopped) return;
      running = true;
      while (dirty && !stopped) {
        dirty = false;
        const at = live?.getSnapshot() ?? idle;
        const frontier = liveRead ? at.frontier : null;
        try {
          const data = await read<T>(path, {
            ...(actor ? { actorId: actor.id } : {}),
            signal: controller.signal,
            frontier,
            mode:
              frontier && appliedReset.current === at.reset
                ? "refresh"
                : "reset",
          });
          if (stopped) break;
          const latest = live?.getSnapshot() ?? idle;
          if (liveRead && latest.revision !== at.revision) {
            dirty = true;
            continue;
          }
          appliedReset.current = at.reset;
          setState({ path, data, error: null, revision: at.revision });
        } catch (error) {
          if (stopped) break;
          if (error instanceof ApiError && error.code === "ACTOR_CHANGED")
            actor?.changed();
          if (
            error instanceof ApiError &&
            ["INVALID_READ_FRONTIER", "READ_FRONTIER_EXPIRED"].includes(
              error.code,
            )
          ) {
            live?.discardMinimum();
            dirty = true;
            continue;
          }
          setState((previous) => ({
            path,
            data:
              previous.path === path &&
              !(
                error instanceof ApiError &&
                ([401, 403, 404].includes(error.status) ||
                  error.code === "ACTOR_CHANGED")
              )
                ? previous.data
                : null,
            error,
            revision: -1,
          }));
          break;
        }
      }
      running = false;
    };
    const unsubscribe = liveRead
      ? live?.subscribe(() => {
          dirty = true;
          void run();
        })
      : undefined;
    void run();
    return () => {
      stopped = true;
      controller.abort();
      unsubscribe?.();
    };
  }, [path, live, liveRead, reload, actor?.id]);
  const current = state.path === path;
  const data = current ? state.data : null;
  return {
    data,
    error: current ? state.error : null,
    loading: !!path && !data && (!current || !state.error),
    stale:
      !!path &&
      (!current ||
        (liveRead &&
          (state.revision !== snapshot.revision ||
            snapshot.phase !== "connected")) ||
        !!state.error),
    reload: () => {
      appliedReset.current = -1;
      setReload((n) => n + 1);
    },
  };
}
