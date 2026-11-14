export type LiveState = {
  phase: "connecting" | "connected" | "reconnecting" | "offline";
  generation: string | null;
  frontier: string | null;
  revision: number;
  reset: number;
};
type Frame = { generation: string; frontier: string };

export class LiveConnection {
  private state: LiveState = {
    phase: "connecting",
    generation: null,
    frontier: null,
    revision: 0,
    reset: 0,
  };
  private listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private active = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  constructor(
    readonly eventId: string,
    private readonly open = (url: string) => new EventSource(url),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  recover = () => {
    if (this.active)
      this.update({
        revision: this.state.revision + 1,
        reset: this.state.reset + 1,
      });
  };
  discardMinimum = () => {
    if (this.active)
      this.update({
        frontier: null,
        revision: this.state.revision + 1,
        reset: this.state.reset + 1,
      });
  };
  start = () => {
    this.active = true;
    this.connect();
    return () => {
      this.active = false;
      clearTimeout(this.retry);
      this.source?.close();
      this.source = null;
    };
  };
  suspend = () => {
    clearTimeout(this.retry);
    this.source?.close();
    this.source = null;
    this.update({ phase: "offline" });
  };
  resume = () => {
    if (this.active && !this.source) this.connect();
    this.recover();
  };
  private connect() {
    if (!this.active) return;
    clearTimeout(this.retry);
    const source = this.open(`/api/events/${this.eventId}/live`);
    this.source = source;
    const frame = (event: MessageEvent, reset: boolean) => {
      if (!this.active || source !== this.source) return;
      let value: Frame;
      try {
        value = JSON.parse(event.data) as Frame;
      } catch {
        return;
      }
      if (
        typeof value.generation !== "string" ||
        typeof value.frontier !== "string"
      )
        return;
      const newGeneration = this.state.generation !== value.generation;
      this.attempts = 0;
      this.update({
        phase: "connected",
        ...value,
        revision: this.state.revision + 1,
        reset: this.state.reset + (reset || newGeneration ? 1 : 0),
      });
    };
    source.addEventListener("ready", (event) =>
      frame(event as MessageEvent, true),
    );
    source.addEventListener("refresh", (event) =>
      frame(event as MessageEvent, false),
    );
    const disconnected = () => {
      if (source !== this.source || !this.active) return;
      source.close();
      this.source = null;
      this.update({
        phase: "reconnecting",
        revision: this.state.revision + 1,
        reset: this.state.reset + 1,
      });
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5));
      this.retry = setTimeout(
        () => this.connect(),
        delay + Math.random() * 500,
      );
    };
    source.addEventListener("reset", disconnected);
    source.onerror = disconnected;
  }
}
