import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  loadIntent,
  read,
  saveIntent,
  clearIntent,
  send,
  type PendingIntent,
} from "./api";
import type { Decision } from "./model";

async function credentialDigest(
  intent: PendingIntent,
  body: Record<string, unknown>,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      intent.key,
      intent.actorId,
      intent.eventId,
      intent.path,
      body,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function useCommands(
  actorId: string,
  eventId: string,
  refresh: (completed: PendingIntent, result: Decision) => void,
  actorChanged: () => void = () => {},
) {
  const [pending, setPending] = useState<PendingIntent | null>(() =>
    loadIntent(actorId, eventId),
  );
  const intent = useRef(pending);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const keep = (next: PendingIntent | null) => {
    if (!mounted.current) return;
    if (next) saveIntent(next);
    else if (intent.current) clearIntent(intent.current);
    intent.current = next;
    setPending(next);
  };
  const settle = (result: Decision) => {
    if (!mounted.current) return false;
    if (result.outcome !== "committed" && result.outcome !== "rejected") {
      setNotice(
        "The result is still unconfirmed. Check its status before starting another action.",
      );
      return false;
    }
    const completed = intent.current;
    keep(null);
    if (completed) refresh(completed, result);
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
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (secret) next.credentialDigest = await credentialDigest(next, body);
      if (!mounted.current) return null;
      keep(next);
      const result = await send(next, body);
      return settle(result) ? result : null;
    } catch (error) {
      if (!mounted.current) return null;
      if (error instanceof ApiError && error.code === "ACTOR_CHANGED")
        actorChanged();
      if (error instanceof ApiError) {
        keep(null);
      }
      setError(error);
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
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
      if (!mounted.current) return;
      if (result.outcome !== "unresolved") {
        settle(result);
        return;
      }
      if (!retry) {
        settle(result);
        return;
      }
      const body = current.body ?? (credential ? { code: credential } : null);
      if (!body) {
        setNotice(
          "Re-enter the original invitation code to retry this same action, or check its status again.",
        );
        return;
      }
      if (
        !current.body &&
        (!current.credentialDigest ||
          (await credentialDigest(current, body)) !== current.credentialDigest)
      ) {
        setError(new ApiError(400, "CREDENTIAL_MISMATCH"));
        return;
      }
      if (!mounted.current) return;
      settle(await send(current, body));
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.code === "ACTOR_CHANGED")
        actorChanged();
      if (error instanceof ApiError && error.code === "INVALID_INPUT") {
        keep(null);
      }
      setError(error);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
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
