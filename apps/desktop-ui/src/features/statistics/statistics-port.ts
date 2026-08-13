/**
 * Native-data boundary for the statistics surface.
 *
 * A composition root can adapt the existing reading-statistics command to this
 * port. The UI must never receive a Tauri `invoke` function, a
 * database handle, or a browser global.
 */
import type {
  ReadingStatsRange,
  ReadingStatsRangeRequest,
} from "../reading-stats/reading-stats-port.js";

export type StatisticsRange = ReadingStatsRange;
export type StatisticsRangeRequest = ReadingStatsRangeRequest;

export interface StatisticsPort {
  getRange(request: StatisticsRangeRequest, signal: AbortSignal): Promise<StatisticsRange>;
}
