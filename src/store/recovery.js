// Keeps the in-progress workout in phone storage so a reload does not lose it (AC11).
// Never throws: storage can be missing, full or blocked (private mode), and the stored text can be
// stale or corrupted. Failures come back as `false` (save/clear) or `null` (load).

const KEY = "bkool-control:recovery";
const VERSION = 1;
// idle has nothing to recover. finished stays recoverable until the app clears it after download.
const RECOVERABLE = new Set(["running", "paused", "finished"]);

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // some browsers throw on access when site data is blocked
  }
}

const isWorkout = (w) =>
  w != null && typeof w === "object" && RECOVERABLE.has(w.status) && Array.isArray(w.samples);

/** @param {{getItem, setItem, removeItem}} [storage] localStorage-shaped. */
export function createRecovery(storage = defaultStorage()) {
  return {
    /** Stores a running/paused/finished workout. Idle/invalid: no-op. Returns true if stored. */
    save(w) {
      if (!isWorkout(w)) return false;
      try {
        storage.setItem(KEY, JSON.stringify({ v: VERSION, workout: w }));
        return true;
      } catch {
        return false;
      }
    },

    /** The stored workout, or null if missing, unreadable or of an unknown version/shape. */
    load() {
      try {
        const raw = storage.getItem(KEY);
        if (typeof raw !== "string") return null;
        const data = JSON.parse(raw);
        if (data?.v !== VERSION || !isWorkout(data.workout)) return null;
        return data.workout;
      } catch {
        return null;
      }
    },

    /** Removes the stored workout. Returns true if the storage accepted the removal. */
    clear() {
      try {
        storage.removeItem(KEY);
        return true;
      } catch {
        return false;
      }
    },
  };
}
