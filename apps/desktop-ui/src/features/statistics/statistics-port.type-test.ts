import type { StatisticsPort, StatisticsRange } from "./statistics-port.js";

declare const port: StatisticsPort;
declare const range: StatisticsRange;
const signal = new AbortController().signal;

void port.getRange({ from: 20260812, to: 20260812 }, signal).then((value) => {
  const totalSeconds: number = value.total_seconds;
  void totalSeconds;
});

// @ts-expect-error Statistics data must have both inclusive range bounds.
void port.getRange({ from: 20260812 }, signal);

// @ts-expect-error Feature ports must not expose a raw Tauri command dispatcher.
const unsafePort: StatisticsPort = { invoke: async () => range };
void unsafePort;
