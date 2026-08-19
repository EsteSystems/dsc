import { useEffect, useState } from "react";
import { getState, subscribe, type StoreState } from "../store.js";

// React hook that selects a slice of store state and re-renders the
// component when that slice changes (referential equality check by default).
//
// const messages = useStore((s) => s.history);
//
// Pass `keys` when the selector only depends on a few store fields. The
// subscription then fires only for patches touching those keys, so e.g. the
// task list can update without notifying the history/status subscribers.
// `keys` is treated as a primitive list — array identity isn't part of the
// effect dependency, so inline arrays don't cause resubscribes on every tick.
export function useStore<T>(
  selector: (s: StoreState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
  keys?: string[],
): T {
  const [value, setValue] = useState(() => selector(getState()));
  const keysKey = keys ? keys.join("\u0000") : undefined;
  useEffect(() => {
    return subscribe(() => {
      const next = selector(getState());
      setValue((prev) => (equalityFn(prev, next) ? prev : next));
    }, keysKey ? keysKey.split("\u0000") : undefined);
  }, [selector, equalityFn, keysKey]);
  return value;
}
