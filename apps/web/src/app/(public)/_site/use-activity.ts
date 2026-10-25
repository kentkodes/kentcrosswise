"use client";
import { useSyncExternalStore } from "react";
import { createActivityStore, initialSnapshot } from "./activity";

const store = createActivityStore();
export function useActivity() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => initialSnapshot);
}
