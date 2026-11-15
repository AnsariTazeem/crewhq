const key = "crewhq.invitation";
export function clearInvitation() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* No persistent context. */
  }
}
export function invitationTimeRemaining() {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return Math.max(
      0,
      Math.min(300_000, Number(value?.expiresAt) - Date.now() || 0),
    );
  } catch {
    return 0;
  }
}
export function captureInvitation(eventId: string): string {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = fragment.get("code");
  if (fragment.has("code"))
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (code && /^[A-Za-z0-9_-]{22}$/.test(code)) {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ eventId, code, expiresAt: Date.now() + 300_000 }),
      );
    } catch {
      /* The current page can still confirm the invitation. */
    }
    return code;
  }
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      value?.eventId === eventId &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now() &&
      typeof value.code === "string" &&
      /^[A-Za-z0-9_-]{22}$/.test(value.code)
    )
      return value.code;
    clearInvitation();
  } catch {
    clearInvitation();
  }
  return "";
}
