import { useEffect, useState } from "react";
import { getState, subscribe, type StoreState } from "../store.js";

// React hook that selects a slice of store state and re-renders the
// component when that slice changes (referential equality check by default).
//
// const messages = useStore((s) => s.history);
export function useStore<T>(
  selector: (s: StoreState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const [value, setValue] = useState(() => selector(getState()));
  useEffect(() => {
    return subscribe(() => {
      const next = selector(getState());
      setValue((prev) => (equalityFn(prev, next) ? prev : next));
    });
  }, [selector, equalityFn]);
  return value;
}
