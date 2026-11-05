// Builds a Garmin TCX (TrainingCenterDatabase v2) that Strava imports as a bike ride.
// Pure: no clock, no DOM. Every interpolated value is a number or an ISO string we derive.

const NS_TCX = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2";
const NS_EXT = "http://www.garmin.com/xmlschemas/ActivityExtension/v2";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
// TCX allows heart rates 1-255; 0 means the strap had no skin contact, so it is not a reading.
const isHr = (x) => isNum(x) && x >= 1 && x <= 255;
const int = (v) => Math.round(isNum(v) ? v : 0);
const mean = (values) =>
  values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;

/**
 * @param {Array<{t:number, watts:number, cadence:number|null, hr:number|null, speedKmh:number}
 *   | {t:number, gap:true}>} samples t = whole seconds of workout time (pauses excluded)
 * @param {string} startIso workout start, ISO 8601 UTC
 * @returns {string}
 *
 * TotalTimeSeconds = last sample t + 1 (gaps included), which equals workout.summary's
 * durationS for a recovered/unfinished workout. A finished workout's durationS comes from its
 * clock and may differ by under a second; samples alone cannot tell, so we use the samples.
 */
export function build(samples, startIso) {
  const startMs = Date.parse(startIso);
  const all = samples ?? [];
  const data = all.filter((s) => !s.gap);

  let meters = 0;
  const points = data.map((s) => {
    meters += (isNum(s.speedKmh) ? Math.max(0, s.speedKmh) : 0) / 3.6; // one second per sample
    return trackpoint(s, startMs, meters);
  });

  const totalS = all.length ? Math.max(...all.map((s) => int(s.t))) + 1 : 0;
  const hrs = data.map((s) => s.hr).filter(isHr);
  const hrLap = hrs.length
    ? `
        <AverageHeartRateBpm><Value>${mean(hrs)}</Value></AverageHeartRateBpm>
        <MaximumHeartRateBpm><Value>${Math.round(Math.max(...hrs))}</Value></MaximumHeartRateBpm>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="${NS_TCX}" xmlns:ns3="${NS_EXT}">
  <Activities>
    <Activity Sport="Biking">
      <Id>${startIso}</Id>
      <Lap StartTime="${startIso}">
        <TotalTimeSeconds>${totalS}</TotalTimeSeconds>
        <DistanceMeters>${meters.toFixed(1)}</DistanceMeters>
        <Calories>0</Calories>${hrLap}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${points.join("\n")}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

function trackpoint(s, startMs, meters) {
  const time = new Date(startMs + int(s.t) * 1000).toISOString();
  const hr = isHr(s.hr) ? `<HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>` : "";
  const cad = isNum(s.cadence) ? `<Cadence>${Math.round(s.cadence)}</Cadence>` : "";
  return `          <Trackpoint>
            <Time>${time}</Time>
            <DistanceMeters>${meters.toFixed(1)}</DistanceMeters>
            ${hr}${cad}
            <Extensions><ns3:TPX><ns3:Watts>${int(s.watts)}</ns3:Watts></ns3:TPX></Extensions>
          </Trackpoint>`;
}
