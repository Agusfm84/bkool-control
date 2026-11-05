import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "../src/core/tcx.js";
import { summary } from "../src/core/workout.js";

const START = "2026-01-02T10:00:00.000Z";
const data = (t, watts, cadence, hr, speedKmh = 36) => ({ t, watts, cadence, hr, speedKmh });

const SAMPLES = [
  data(0, 150, 80, 120),
  data(1, 160, 82, 122),
  { t: 2, gap: true },
  data(3, 170, 84, 124),
];

// Tiny structural check: balanced, properly nested tags (no dependency).
function assertWellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "");
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  let m = re.exec(body);
  while (m) {
    assert.equal(body.slice(last, m.index).includes("<"), false, "stray '<'");
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]);
    last = re.lastIndex;
    m = re.exec(body);
  }
  assert.equal(body.slice(last).includes("<"), false, "stray '<' at end");
  assert.deepEqual(stack, [], "unclosed tags");
}

const count = (xml, tag) => (xml.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;

test("output is well-formed XML for a Biking activity with the start as Id", () => {
  const xml = build(SAMPLES, START);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assertWellFormed(xml);
  assert.match(xml, /<Activity Sport="Biking">/);
  assert.match(xml, new RegExp(`<Id>${START}</Id>`));
  assert.match(xml, /<Lap StartTime="2026-01-02T10:00:00.000Z">/);
  assert.equal(count(xml, "Lap"), 1);
  assert.match(xml, /<Intensity>Active<\/Intensity>/);
  assert.match(xml, /<TriggerMethod>Manual<\/TriggerMethod>/);
  assert.match(xml, /xmlns:ns3="http:\/\/www.garmin.com\/xmlschemas\/ActivityExtension\/v2"/);
});

test("one trackpoint per data sample; gaps produce none", () => {
  const xml = build(SAMPLES, START);
  assert.equal(count(xml, "Trackpoint"), 3);
  assert.equal(xml.includes("<Time>2026-01-02T10:00:02.000Z</Time>"), false);
  assert.ok(xml.includes("<Time>2026-01-02T10:00:03.000Z</Time>"));
});

test("HR, cadence and Watts are present when given", () => {
  const xml = build([data(0, 150, 80, 120)], START);
  assert.match(xml, /<HeartRateBpm><Value>120<\/Value><\/HeartRateBpm>/);
  assert.match(xml, /<Cadence>80<\/Cadence>/);
  assert.match(xml, /<ns3:TPX><ns3:Watts>150<\/ns3:Watts><\/ns3:TPX>/);
});

test("HR and cadence are absent when null; Watts stays", () => {
  const xml = build([data(0, 150, null, null), data(1, 0, null, null)], START);
  assertWellFormed(xml);
  assert.equal(xml.includes("HeartRateBpm"), false);
  assert.equal(xml.includes("<Cadence>"), false);
  assert.equal(count(xml, "ns3:Watts"), 2);
});

test("distance is cumulative from speed, one second per sample", () => {
  const xml = build([data(0, 1, 1, 1, 36), data(1, 1, 1, 1, 36), { t: 2, gap: true }], START);
  const d = [...xml.matchAll(/<Trackpoint>[\s\S]*?<DistanceMeters>([\d.]+)<\/DistanceMeters>/g)];
  assert.deepEqual(
    d.map((x) => Number(x[1])),
    [10, 20],
  );
  assert.match(xml, /<Lap [^>]*>[\s\S]*<DistanceMeters>20\.0<\/DistanceMeters>[\s\S]*<Track>/);
});

test("lap totals agree with workout.summary for the same samples", () => {
  const w = { samples: SAMPLES, lastSecond: 3, finishedAt: null };
  const s = summary(w);
  const xml = build(SAMPLES, START);
  assert.match(xml, new RegExp(`<TotalTimeSeconds>${s.durationS}</TotalTimeSeconds>`));
  assert.equal(s.durationS, 4); // gap seconds still count as workout time
  assert.match(xml, /<AverageHeartRateBpm><Value>122<\/Value><\/AverageHeartRateBpm>/);
  assert.match(xml, /<MaximumHeartRateBpm><Value>124<\/Value><\/MaximumHeartRateBpm>/);
});

test("empty and all-gap input yields a valid file with no NaN or undefined", () => {
  for (const samples of [[], [{ t: 0, gap: true }]]) {
    const xml = build(samples, START);
    assertWellFormed(xml);
    assert.equal(count(xml, "Trackpoint"), 0);
    assert.equal(/NaN|undefined|null/.test(xml), false);
  }
});
