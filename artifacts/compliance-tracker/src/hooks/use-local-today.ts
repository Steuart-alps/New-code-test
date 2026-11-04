import { useEffect, useState } from "react";

/** Milliseconds from `now` to the next local midnight (23 or 25 hours on a clock-change day). */
export function msUntilNextLocalMidnight(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * "Today" for date-only comparisons such as certificate expiry. A page left
 * open overnight gets a new value at local midnight, and again when the tab is
 * shown or focused after the date changed (a sleeping laptop or a throttled
 * background tab can miss the timer). Within one day the same Date is kept, so
 * memoised lists are not recomputed.
 */
export function useLocalToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      const now = new Date();
      setToday(previous => sameLocalDay(previous, now) ? previous : now);
      window.clearTimeout(timer);
      // A second past midnight, so a timer that fires a little early still
      // lands on the new day.
      timer = window.setTimeout(refresh, msUntilNextLocalMidnight(now) + 1000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return today;
}
