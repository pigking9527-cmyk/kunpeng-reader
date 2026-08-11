import type { ReadingStatsPort, ReadingStatsRange } from "./reading-stats-port.js";

declare const port: ReadingStatsPort;
declare const range: ReadingStatsRange;
const controller = new AbortController();

void port.getRange({ from: 20260810, to: 20260810 }, controller.signal).then((value) => {
  const hours: readonly number[] = value.hours;
  void hours;
});

const complete: ReadingStatsRange = range;
void complete;

// @ts-expect-error The native range must always be an inclusive two-boundary request.
void port.getRange({ from: 20260810 }, controller.signal);

// @ts-expect-error A port cannot expose a raw invoke command to a feature.
const unsafePort: ReadingStatsPort = { invoke: async () => range };
void unsafePort;
