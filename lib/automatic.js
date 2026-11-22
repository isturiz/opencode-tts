const outcomes = ["started", "succeeded", "failed", "interrupted"];

async function invoke(callback, ...args) {
  try {
    await callback(...args);
  } catch {
    // The speech handler owns error reporting; don't leak errors into the event bus.
  }
}

export function registerAutomatic(context, { isEnabled, start, cancel }) {
  const { data } = context;
  if (typeof data?.on !== "function") return () => {};

  const lastSequence = new Map();
  let eligible;
  let disposed = false;

  function handle(event, outcome) {
    const sessionID = event?.data?.sessionID;
    if (disposed || !sessionID) return;

    // A repeated terminal event must not consume a newer execution's start.
    const seq = event.durable?.seq;
    if (Number.isSafeInteger(seq)) {
      if (seq <= (lastSequence.get(sessionID) ?? -1)) return;
      lastSequence.set(sessionID, seq);
    }

    const route = context.ui.router.current();
    const visible = route.type === "session" ? route.sessionID : undefined;
    const enabled = isEnabled();
    if (eligible && (!enabled || eligible.sessionID !== visible)) eligible = undefined;

    if (outcome === "started") {
      if (enabled && sessionID === visible) {
        const startedAt = Number.isFinite(event.created) ? event.created : undefined;
        eligible = { sessionID, startedAt };
      }
      void invoke(cancel, sessionID);
      return;
    }

    if (eligible?.sessionID !== sessionID) return;
    const { startedAt } = eligible;
    eligible = undefined;
    if (outcome === "succeeded") void invoke(start, sessionID, startedAt);
  }

  const subscriptions = outcomes.map((outcome) =>
    data.on(`session.execution.${outcome}`, (event) => handle(event, outcome))
  );

  return () => {
    if (disposed) return;
    disposed = true;
    eligible = undefined;
    lastSequence.clear();
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}
