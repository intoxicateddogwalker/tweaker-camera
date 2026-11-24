// Node tests for the pure logic in ../logic.js. Run with: node tests/run-tests.mjs
// No dependencies. Exits non-zero if any test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../logic.js");

const MIN = 60 * 1000;
const NOW = Date.parse("2026-11-23T12:00:00Z");

// --- Cooldown ---------------------------------------------------------
test("shouldNotify: never notified -> notify", () => {
  assert.equal(L.shouldNotify(null, NOW, 30), true);
  assert.equal(L.shouldNotify(undefined, NOW, 30), true);
});

test("shouldNotify: inside the window -> stay quiet", () => {
  assert.equal(L.shouldNotify(NOW - 5 * MIN, NOW, 30), false);
  assert.equal(L.shouldNotify(NOW - 29 * MIN, NOW, 30), false);
});

test("shouldNotify: at and past the boundary -> notify", () => {
  assert.equal(L.shouldNotify(NOW - 30 * MIN, NOW, 30), true);
  assert.equal(L.shouldNotify(NOW - 31 * MIN, NOW, 30), true);
});

test("shouldNotify: cooldown 0 always notifies; future last-time stays quiet", () => {
  assert.equal(L.shouldNotify(NOW - 1 * MIN, NOW, 0), true);
  assert.equal(L.shouldNotify(NOW + 5 * MIN, NOW, 30), false);
});

test("shouldNotify: bad inputs do not throw", () => {
  assert.equal(L.shouldNotify("nope", NOW, 30), true);
  assert.equal(L.shouldNotify(null, "nope", 30), false);
});

// --- Rolling-window counting ------------------------------------------
test("countInWindow: counts only the last 7 days", () => {
  const day = 24 * 60 * MIN;
  const ts = [NOW, NOW - 1 * day, NOW - 6 * day, NOW - 7 * day, NOW - 8 * day, NOW + MIN];
  // exactly 7 days ago is outside (window is open on the left); future excluded
  assert.equal(L.countInWindow(ts, NOW), 3);
});

test("countInWindow: empty and bad input -> 0", () => {
  assert.equal(L.countInWindow([], NOW), 0);
  assert.equal(L.countInWindow(null, NOW), 0);
  assert.equal(L.countInWindow(["junk", NOW], NOW), 1);
});

test("isRepeatSuspicious: fires when the count reaches the threshold", () => {
  assert.equal(L.isRepeatSuspicious(2, 3), false);
  assert.equal(L.isRepeatSuspicious(3, 3), true);
  assert.equal(L.isRepeatSuspicious(5, 3), true);
  assert.equal(L.isRepeatSuspicious(0, 3), false);
});

// --- Signatures ---------------------------------------------------------
function flatGray(value) {
  return Array(64).fill(value);
}

function splitGray() {
  // Left half dark, right half bright: a stable, non-flat pattern.
  const pixels = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) pixels.push(col < 4 ? 20 : 230);
  }
  return pixels;
}

test("averageHash: flat image hashes to all zeros", () => {
  assert.equal(L.averageHash(flatGray(128)), "0".repeat(64));
});

test("averageHash: split image hashes to the expected pattern", () => {
  const hash = L.averageHash(splitGray());
  assert.equal(hash, "00001111".repeat(8));
});

test("averageHash: wrong length or bad values -> null", () => {
  assert.equal(L.averageHash([1, 2, 3]), null);
  assert.equal(L.averageHash(Array(64).fill("x")), null);
});

test("histogram: sums to 1 and bins correctly", () => {
  const hist = L.histogram(splitGray());
  assert.equal(hist.length, 8);
  assert.ok(Math.abs(hist.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(hist[0], 0.5);
  assert.equal(hist[7], 0.5);
});

test("hammingDistance: identical 0, one bit 1, opposite 64", () => {
  assert.equal(L.hammingDistance("0".repeat(64), "0".repeat(64)), 0);
  assert.equal(L.hammingDistance("1" + "0".repeat(63), "0".repeat(64)), 1);
  assert.equal(L.hammingDistance("1".repeat(64), "0".repeat(64)), 64);
  assert.equal(L.hammingDistance("abc", "0".repeat(64)), -1);
});

test("signaturesMatch: identical matches, very different does not", () => {
  const a = L.makeSignature(splitGray());
  const b = L.makeSignature(splitGray());
  const dark = L.makeSignature(flatGray(10));
  const bright = L.makeSignature(flatGray(245));
  assert.equal(L.signaturesMatch(a, b), true);
  assert.equal(L.signaturesMatch(dark, bright), false);
  assert.equal(L.signaturesMatch(a, dark), false);
});

test("signaturesMatch: a few flipped bits still matches; many do not", () => {
  const base = splitGray();
  const near = base.slice();
  near[0] = 230; // flip 3 pixels across the mean
  near[1] = 230;
  near[8] = 230;
  const far = base.map((v) => (v === 20 ? 230 : 20)); // invert everything
  assert.equal(L.signaturesMatch(L.makeSignature(base), L.makeSignature(near)), true);
  assert.equal(L.signaturesMatch(L.makeSignature(base), L.makeSignature(far)), false);
});

test("findBestMatch: returns the closest stored match, null when none", () => {
  const sig = L.makeSignature(splitGray());
  const stored = [
    { id: "other", signature: L.makeSignature(flatGray(10)) },
    { id: "same", signature: L.makeSignature(splitGray()) },
  ];
  assert.equal(L.findBestMatch(sig, stored).id, "same");
  assert.equal(L.findBestMatch(sig, []), null);
  assert.equal(L.findBestMatch(sig, [{ id: "x", signature: L.makeSignature(flatGray(245)) }]), null);
});

// --- Speech-queue dedupe -------------------------------------------------
test("shouldQueueSpeech: fresh text queues; queued or recently spoken does not", () => {
  const spoken = { text: "Alex is on camera.", at: NOW - 5000 };
  assert.equal(L.shouldQueueSpeech("Alex is on camera.", spoken, [], NOW), false); // spoken 5s ago
  assert.equal(L.shouldQueueSpeech("Alex is on camera.", { text: "Alex is on camera.", at: NOW - 11000 }, [], NOW), true); // window passed
  assert.equal(L.shouldQueueSpeech("Someone is at the gate.", spoken, [], NOW), true); // different text
  assert.equal(L.shouldQueueSpeech("Someone is at the gate.", null, ["Someone is at the gate."], NOW), false); // already queued
  assert.equal(L.shouldQueueSpeech("", null, [], NOW), false);
  assert.equal(L.shouldQueueSpeech("  ", null, [], NOW), false);
  assert.equal(L.shouldQueueSpeech("Hi.", null, [], "nope"), false);
});

// --- Save-boundary guard: no image data ----------------------------------
test("stripImageData: drops every image field and data: URL, keeps the rest", () => {
  const record = {
    id: "p1",
    name: "Alex",
    signatures: [{ hash: "0".repeat(64), hist: [0.5, 0.5, 0, 0, 0, 0, 0, 0] }],
    crop: "data:image/jpeg;base64,/9j/xxx",
    cropDataUrl: "data:image/jpeg;base64,/9j/yyy",
    previewDataUrl: "data:image/jpeg;base64,/9j/zzz",
    photo: "data:image/png;base64,abc",
    firstSeen: NOW,
  };
  const clean = L.stripImageData(record);
  assert.equal(clean.id, "p1");
  assert.equal(clean.name, "Alex");
  assert.deepEqual(clean.signatures, record.signatures);
  assert.equal(clean.firstSeen, NOW);
  assert.equal("crop" in clean, false);
  assert.equal("cropDataUrl" in clean, false);
  assert.equal("previewDataUrl" in clean, false);
  assert.equal("photo" in clean, false);
  // Nothing image-like survives anywhere in the cleaned record.
  assert.equal(JSON.stringify(clean).includes("data:image"), false);
  // The original record is untouched (the guard copies, it does not mutate).
  assert.equal(record.crop.startsWith("data:image"), true);
});

test("stripImageData: enrollment-shaped record keeps no picture at all", () => {
  // Simulates a record that accidentally carried the transient enrollment
  // picture (shown while asking who someone/a car is). Saving must drop
  // every image field, so no enrollment photo can survive saving.
  const record = {
    id: "c1",
    signatures: [{ hash: "0".repeat(64), hist: [1, 0, 0, 0, 0, 0, 0, 0] }],
    livesNearby: true,
    dataUrl: "data:image/jpeg;base64,/9j/enroll",
    previewDataUrl: "data:image/jpeg;base64,/9j/preview",
    firstSeen: NOW,
  };
  const clean = L.stripImageData(record);
  assert.equal("dataUrl" in clean, false);
  assert.equal("previewDataUrl" in clean, false);
  assert.equal(clean.livesNearby, true);
  assert.deepEqual(clean.signatures, record.signatures);
  assert.equal(JSON.stringify(clean).includes("data:image"), false);
});

test("stripImageData: non-records pass through untouched", () => {
  assert.equal(L.stripImageData(null), null);
  assert.equal(L.stripImageData("data:image/jpeg;base64,x"), "data:image/jpeg;base64,x");
});

// --- Event-snapshot expiry ------------------------------------------------
test("snapshotExpired: unsaved expires after retention, saved never does", () => {
  const hour = 60 * MIN;
  assert.equal(L.snapshotExpired(NOW - 5 * hour, NOW, 6, false), false);
  assert.equal(L.snapshotExpired(NOW - 6 * hour, NOW, 6, false), true); // exactly at the boundary
  assert.equal(L.snapshotExpired(NOW - 7 * hour, NOW, 6, false), true);
  assert.equal(L.snapshotExpired(NOW - 7 * hour, NOW, 6, true), false); // saved: exempt
  assert.equal(L.snapshotExpired(NOW - 1 * hour, NOW, 6, true), false);
  assert.equal(L.snapshotExpired(NOW - 3 * hour, NOW, 3, false), true); // custom retention
  assert.equal(L.snapshotExpired("junk", NOW, 6, false), false); // bad input: keep, do not crash
});

test("snapshotTimeLeftMs: counts down, 0 when expired, Infinity when saved", () => {
  const hour = 60 * MIN;
  assert.equal(L.snapshotTimeLeftMs(NOW - 5 * hour, NOW, 6, false), hour);
  assert.equal(L.snapshotTimeLeftMs(NOW - 7 * hour, NOW, 6, false), 0);
  assert.equal(L.snapshotTimeLeftMs(NOW - 7 * hour, NOW, 6, true), Infinity);
});

// --- Hugging Face deployment + token masking ------------------------------
test("modelDeploymentLive: object form with a live provider -> true", () => {
  // Shape returned by GET /api/models/facebook/detr-resnet-50 (verified live).
  assert.equal(
    L.modelDeploymentLive({ "hf-inference": { status: "live", providerId: "facebook/detr-resnet-50", task: "object-detection" } }),
    true
  );
});

test("modelDeploymentLive: empty mapping means not deployed -> false", () => {
  // Shape returned for Salesforce/blip-image-captioning-base (and -large,
  // nlpconnect/vit-gpt2-image-captioning, microsoft/git-base-coco): the
  // model page says it isn't deployed by any Inference Provider.
  assert.equal(L.modelDeploymentLive({}), false);
  assert.equal(L.modelDeploymentLive([]), false);
  assert.equal(L.modelDeploymentLive(null), false);
  assert.equal(L.modelDeploymentLive(undefined), false);
  assert.equal(L.modelDeploymentLive("live"), false);
});

test("modelDeploymentLive: array form and non-live statuses", () => {
  assert.equal(L.modelDeploymentLive([{ provider: "a", status: "live" }]), true);
  assert.equal(L.modelDeploymentLive([{ provider: "a", status: "error" }]), false);
  assert.equal(L.modelDeploymentLive([{ provider: "a", status: "staging" }]), false);
  assert.equal(
    L.modelDeploymentLive({ "hf-inference": { status: "error" }, other: { status: "live" } }),
    true
  );
});

test("maskToken: shows only first 3 and last 4, never the full token", () => {
  assert.equal(L.maskToken("hf_abcdefgh1234"), "hf_…1234");
  assert.equal(L.maskToken(""), "");
  assert.equal(L.maskToken("   "), "");
  assert.equal(L.maskToken("short"), "••••");
  assert.equal(L.maskToken(null), "");
  assert.ok(!L.maskToken("hf_abcdefgh1234").includes("abcdefgh"));
});

// --- Watch zones ---------------------------------------------------------
test("detectionInZone: centre inside, overlap, and fully outside", () => {
  const zone = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  assert.equal(L.detectionInZone({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, zone), true);
  // Centre outside, but the box overlaps the zone edge.
  assert.equal(L.detectionInZone({ x: 0.55, y: 0.3, w: 0.2, h: 0.1 }, zone), true);
  // Fully clear of the zone.
  assert.equal(L.detectionInZone({ x: 0.7, y: 0.7, w: 0.1, h: 0.1 }, zone), false);
  assert.equal(L.detectionInZone(null, zone), false);
  assert.equal(L.detectionInZone({ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, null), false);
});

test("detectionInAnyZone: returns the matching zone or null", () => {
  const zones = [
    { id: "a", x: 0, y: 0, w: 0.2, h: 0.2 },
    { id: "b", x: 0.6, y: 0.6, w: 0.3, h: 0.3 },
  ];
  assert.equal(L.detectionInAnyZone({ x: 0.7, y: 0.7, w: 0.05, h: 0.05 }, zones).id, "b");
  assert.equal(L.detectionInAnyZone({ x: 0.4, y: 0.4, w: 0.05, h: 0.05 }, zones), null);
});

// --- Vehicle pass debouncing --------------------------------------------
test("shouldCountNewPass: first sighting, gap, and within-gap cases", () => {
  assert.equal(L.shouldCountNewPass(null, NOW), true);
  assert.equal(L.shouldCountNewPass(NOW - 9000, NOW), true); // gap passed
  assert.equal(L.shouldCountNewPass(NOW - 3000, NOW), false); // same pass
  assert.equal(L.shouldCountNewPass(NOW - 8000, NOW), false); // exactly at gap: same pass
  assert.equal(L.shouldCountNewPass(NOW - 8001, NOW), true);
});
