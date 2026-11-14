import { useRef, useState } from "react";
import {
  ApiError,
  loadIntent,
  read,
  saveIntent,
  send,
  type PendingIntent,
} from "./api";
import type { Decision } from "./model";

export function useCommands(
  actorId: string,
  eventId: string,
  refresh: () => void,
  actorChanged: () => void = () => {},
) {
  const [pending, setPending] = useState<PendingIntent | null>(() =>
    loadIntent(actorId, eventId),
  );
  const intent = useRef(pending);
  const secretBody = useRef<Record<string, unknown> | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const keep = (next: PendingIntent | null) => {
    intent.current = next;
    setPending(next);
    saveIntent(next, actorId, eventId);
  };
  const settle = (result: Decision) => {
    if (result.outcome !== "committed" && result.outcome !== "rejected") {
      setNotice(
        "The result is still unconfirmed. Check its status before starting another action.",
      );
      return false;
    }
    keep(null);
    secretBody.current = null;
    refresh();
    if (result.outcome === "rejected") {
      setError(
        new ApiError(
          result.originalStatus ?? 409,
          result.code ?? "REQUEST_FAILED",
        ),
      );
      return false;
    }
    setNotice("Saved. Your workspace is updating.");
    return true;
  };
  const run = async (
    path: string,
    body: Record<string, unknown>,
    label: string,
    secret = false,
  ) => {
    if (busyRef.current || intent.current) return null;
    const next: PendingIntent = {
      key: crypto.randomUUID(),
      actorId,
      eventId,
      path,
      label,
      at: Date.now(),
      ...(!secret ? { body } : {}),
    };
    keep(next);
    secretBody.current = body;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await send(next, body);
      return settle(result) ? result : null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "ACTOR_CHANGED")
        actorChanged();
      if (error instanceof ApiError) {
        keep(null);
        secretBody.current = null;
      }
      setError(error);
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const reconcile = async (retry = false, credential?: string) => {
    const current = intent.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await read<Decision>(
        `/events/${eventId}/operations/${current.key}`,
        { actorId },
      );
      if (result.outcome !== "unresolved") {
        settle(result);
        return;
      }
      if (!retry) {
        settle(result);
        return;
      }
      const body =
        current.body ??
        secretBody.current ??
        (credential ? { code: credential } : null);
      if (!body) {
        setNotice(
          "Re-enter the original invitation code to retry this same action, or check its status again.",
        );
        return;
      }
      settle(await send(current, body));
    } catch (error) {
      if (error instanceof ApiError && error.code === "ACTOR_CHANGED")
        actorChanged();
      setError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return {
    pending,
    busy,
    notice,
    error,
    run,
    reconcile,
    clearNotice: () => {
      setNotice(null);
      setError(null);
    },
  };
}
export type Commands = ReturnType<typeof useCommands>;
