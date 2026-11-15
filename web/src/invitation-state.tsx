import { createContext, useContext, useEffect, useState } from "react";
import {
  captureInvitation,
  clearInvitation,
  invitationTimeRemaining,
} from "./invitation-context";

const InvitationContext = createContext({
  code: "",
  revision: 0,
  expiresAt: 0,
  clear: () => {},
});
export const useInvitation = () => {
  const invitation = useContext(InvitationContext);
  return {
    ...invitation,
    code: invitation.expiresAt > Date.now() ? invitation.code : "",
  };
};
export function InvitationProvider({
  eventId,
  children,
}: {
  eventId: string;
  children: React.ReactNode;
}) {
  const capture = () => {
    const code = captureInvitation(eventId);
    return {
      code,
      expiresAt: code ? Date.now() + (invitationTimeRemaining() || 300_000) : 0,
    };
  };
  const [invitation, setInvitation] = useState(() => ({
    ...capture(),
    revision: 0,
  }));
  const clear = () => {
    clearInvitation();
    setInvitation((previous) => ({
      code: "",
      expiresAt: 0,
      revision: previous.revision + 1,
    }));
  };
  useEffect(() => {
    if (!invitation.code) return;
    const timer = setTimeout(
      clear,
      Math.max(0, invitation.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [invitation.expiresAt, invitation.revision]);
  useEffect(() => {
    const changed = () => {
      if (new URLSearchParams(location.hash.slice(1)).has("code"))
        setInvitation((previous) => ({
          ...capture(),
          revision: previous.revision + 1,
        }));
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [eventId]);
  return (
    <InvitationContext.Provider
      value={{
        code: invitation.code,
        revision: invitation.revision,
        expiresAt: invitation.expiresAt,
        clear,
      }}
    >
      {children}
    </InvitationContext.Provider>
  );
}
