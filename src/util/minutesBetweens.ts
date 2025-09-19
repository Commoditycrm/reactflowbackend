// If you want to keep typing support, keep the import; else remove it.
import type { DateTime as Neo4jDateTime, Integer } from "neo4j-driver";

type DTLike =
  | Neo4jDateTime<Integer | number>
  | {
      year: number; month: number; day: number;
      hour: number; minute: number; second: number; nanosecond: number;
      timeZoneOffsetSeconds?: number; timeZoneId?: string | null;
      toStandardDate?: () => Date;
    };

const isDriverDateTime = (d: any): d is Neo4jDateTime<Integer | number> =>
  d && typeof d.toStandardDate === "function";

/** Absolute UTC milliseconds for the given Neo4j DateTime-like value. */
export function toEpochMs(d: DTLike): number {
  if (isDriverDateTime(d) || typeof (d as any)?.toStandardDate === "function") {
    return (d as any).toStandardDate().getTime(); // instant (UTC under the hood)
  }
  const {
    year, month, day, hour, minute, second, nanosecond,
    timeZoneOffsetSeconds = 0,
  } = d as any;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, Math.floor(nanosecond / 1e6));
  return utcMs - timeZoneOffsetSeconds * 1000;
}
