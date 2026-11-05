// Gets the workout file out of the phone. iPhone/Bluefy ignores downloads, so the share sheet is
// used whenever the browser can share files ("Guardar en Archivos"); otherwise a normal download.
// Decision T008b (spike on the owner's iPhone, 2026-11-05).

/**
 * @param {string} name   e.g. "bkool-2026-11-05-1907.tcx"
 * @param {string} text   the TCX content
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
 */
export async function saveFile(name, text) {
  const nav = globalThis.navigator;
  if (nav?.share && nav.canShare) {
    // XML first; some iPhones only accept common types, so plain text as a second try.
    const file = ["application/xml", "text/plain"]
      .map((type) => new File([text], name, { type }))
      .find((f) => nav.canShare({ files: [f] }));
    if (file) {
      try {
        await nav.share({ files: [file], title: name });
        return "shared";
      } catch (err) {
        if (err?.name === "AbortError") return "cancelled";
        // fall through to a download
      }
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a); // some browsers ignore clicks on detached links
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
