/** Builds a DataView from a list of byte values. */
export const view = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);
