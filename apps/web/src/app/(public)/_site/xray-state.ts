// X-ray on/off, remembered for the browser session. A tiny external store so the header toggle and every
// <Xray> wrapper share one value without a provider. Storage can be blocked (private modes, policies); then the
// value lives in memory for the page's lifetime and nothing else changes.
const KEY = "kcw-xray";
const listeners = new Set<() => void>();
let memory: boolean | null = null;

function read(): boolean {
  if (memory !== null) return memory;
  try {
    return window.sessionStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function getXray(): boolean {
  return read();
}

/** What the server renders: off. */
export function getXrayServer(): boolean {
  return false;
}

export function setXray(on: boolean): void {
  memory = on;
  try {
    window.sessionStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: the in-memory value still works for this page */
  }
  for (const listener of listeners) listener();
}

export function subscribeXray(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
