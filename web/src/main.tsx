import { createRoot } from "react-dom/client";
import "@fontsource-variable/dm-sans";
import { App } from "./app";
import { InvitationProvider } from "./invitation-state";
import "./style.css";

const configuredEvent =
  import.meta.env.VITE_EVENT_ID ?? "8ce60ac2-e914-4eaf-a02c-51e854827dcc";
const requestedEvent =
  new URLSearchParams(location.search).get("event") ?? configuredEvent;
const validEvent =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    requestedEvent,
  );
const root = createRoot(document.getElementById("root")!);
if (!validEvent)
  root.render(
    <main className="boot">
      <h1>Invalid event link</h1>
      <p>Ask the organizer for the event’s current workspace link.</p>
      <a href="/">Open default event</a>
    </main>,
  );
else
  root.render(
    <InvitationProvider eventId={requestedEvent}>
      <App eventId={requestedEvent} />
    </InvitationProvider>,
  );
