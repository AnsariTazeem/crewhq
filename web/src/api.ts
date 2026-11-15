import type { Decision } from "./model";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter = 0,
  ) {
    super(code);
  }
}
export async function read<T>(
  path: string,
  options: {
    signal?: AbortSignal;
    frontier?: string | null;
    mode?: "reset" | "refresh";
    actorId?: string;
  } = {},
): Promise<T> {
  const headers = new Headers();
  if (options.actorId) headers.set("X-Actor-Id", options.actorId);
  if (options.frontier) headers.set("X-Read-Frontier", options.frontier);
  headers.set("X-Snapshot-Mode", options.mode ?? "reset");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)])
    : AbortSignal.timeout(12_000);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`/api${path}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new ApiError(
          response.status,
          body.code ?? "REQUEST_FAILED",
          Number(response.headers.get("Retry-After")) || 0,
        );
      if (options.frontier && !response.headers.get("X-Read-Frontier"))
        throw new ApiError(503, "READ_FRESHNESS_UNAVAILABLE");
      return body as T;
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= 2 ||
        (error instanceof ApiError
          ? error.status < 500
          : !(error instanceof TypeError))
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
}
export type PendingIntent = {
  key: string;
  actorId: string;
  eventId: string;
  path: string;
  label: string;
  at: number;
  body?: Record<string, unknown>;
  credentialDigest?: string;
};
const intentPrefix = "crewhq.pending:";
const intentKey = (actorId: string, eventId: string) =>
  `${intentPrefix}${actorId}:${eventId}`;
export function loadIntent(
  actorId: string,
  eventId: string,
): PendingIntent | null {
  try {
    const intent = JSON.parse(
      sessionStorage.getItem(intentKey(actorId, eventId)) ?? "null",
    ) as PendingIntent | null;
    if (
      intent &&
      intent.actorId === actorId &&
      intent.eventId === eventId &&
      typeof intent.key === "string" &&
      typeof intent.path === "string"
    )
      return intent;
  } catch {
    /* Storage may be unavailable. In-memory recovery still works. */
  }
  return null;
}
export function saveIntent(intent: PendingIntent) {
  try {
    sessionStorage.setItem(
      intentKey(intent.actorId, intent.eventId),
      JSON.stringify(intent),
    );
  } catch {
    /* The current tab retains its in-memory intent. */
  }
}
export function clearIntent(intent: PendingIntent) {
  try {
    if (loadIntent(intent.actorId, intent.eventId)?.key === intent.key)
      sessionStorage.removeItem(intentKey(intent.actorId, intent.eventId));
  } catch {
    /* Recovery remains available in memory when storage is unavailable. */
  }
}
export async function send(
  intent: PendingIntent,
  body: Record<string, unknown>,
): Promise<Decision> {
  const response = await fetch(`/api/events/${intent.eventId}${intent.path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-App-Request": "1",
      "Idempotency-Key": intent.key,
      "X-Actor-Id": intent.actorId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const result = (await response.json()) as Decision;
  if (
    result.outcome === "committed" ||
    result.outcome === "rejected" ||
    result.outcome === "unresolved"
  )
    return result;
  if (!response.ok && response.status < 500)
    throw new ApiError(
      response.status,
      result.code ?? "REQUEST_FAILED",
      Number(response.headers.get("Retry-After")) || 0,
    );
  return { outcome: "unresolved", operationKey: intent.key };
}
export function message(error: unknown) {
  const code = error instanceof ApiError ? error.code : "NETWORK_UNAVAILABLE";
  const messages: Record<string, string> = {
    UNAUTHENTICATED: "Your session ended. Sign in again to continue.",
    NOT_ENROLLED: "Register for this event to continue.",
    TEAM_FULL: "This team is full. Contact the leader or choose another team.",
    ALREADY_IN_TEAM:
      "You already have a team in this event. Leave it before joining another.",
    LEADER_REQUIRED: "Only the current team leader can do that.",
    ROSTER_FROZEN:
      "This roster is fixed after submission. Members cannot be added, removed or leave.",
    ADMISSIONS_CLOSED: "Team formation has closed for this event.",
    PERSONAL_REINVITE_REQUIRED:
      "You need a fresh personal invitation from this team's leader to return.",
    INVITE_UNUSABLE:
      "This invitation is expired, revoked or unavailable. Ask the leader for a new one.",
    PROFILE_CHANGED:
      "Your profile changed elsewhere. Refresh it before saving again.",
    TEAM_CHANGED: "The team changed. Review its current state and try again.",
    MEMBERSHIP_CHANGED:
      "Your membership changed. Review your current team before continuing.",
    REQUEST_CANCELLED:
      "This request was cancelled because the participant's membership changed.",
    RATE_LIMITED: "Too many attempts. Wait a moment before trying again.",
    SUCCESSOR_REQUIRED: "Choose the next leader before leaving.",
    SUCCESSOR_CHANGED:
      "That teammate is no longer eligible to lead. Choose a current member.",
    INVALID_INPUT: "Check the form fields and try again.",
    CREDENTIAL_MISMATCH:
      "Enter the original invitation code. A different code cannot retry this unfinished action.",
    RANKING_DATES_UNCONFIGURED:
      "Suggestions need the organizer to configure this event's dates. You can still browse the board.",
    TEAM_NOT_RECRUITING:
      "Your team is full or its roster is fixed. Suggestions are unavailable.",
    NETWORK_UNAVAILABLE:
      "The connection is unavailable. Your current view may be out of date.",
  };
  return (
    messages[code] ??
    "This action is unavailable right now. Refresh the current state and try again."
  );
}
