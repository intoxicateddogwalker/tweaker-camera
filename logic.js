/* Camera Watch AI — pure logic module.
 *
 * Everything in this file is deterministic and has no DOM, network, or
 * storage access, so it can be unit-tested under Node. The browser app
 * (app.js) calls these helpers; the tests in tests/run-tests.mjs cover
 * each one.
 *
 * Honest framing: the "signatures" here are a rough average-hash plus a
 * colour histogram of a small crop. That is enough to *suggest* "this
 * looks like the person/car you named before" and ask the user to
 * confirm. It is NOT face recognition and NOT plate recognition, and it
 * must never be presented as either.
 *
 * No image data is ever stored: a stored record holds ONLY the numeric
 * signature (hash string + histogram numbers), the name the user gave,
 * and timestamps. stripImageData() is the save-boundary guard — the
 * app must pass every person/car record through it before persisting,
 * so a picture can never reach storage even by accident.
 */
(function (root) {
  "use strict";

  var SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  function toMs(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  /* ------------------------------------------------------------------ */
  /* Notification cooldown                                               */
  /*                                                                     */
  /* shouldNotify(lastNotifiedAtMs, nowMs, cooldownMinutes)              */
  /*   lastNotifiedAtMs: epoch ms of the last alert for this subject, or  */
  /*   null/undefined if never notified.                                */
  /*   Returns true when an alert may be raised now. A cooldown of 0     */
  /*   means "always notify". Times in the future are treated as "just   */
  /*   notified" (no alert) rather than crashing.                       */
  /* ------------------------------------------------------------------ */
  function shouldNotify(lastNotifiedAtMs, nowMs, cooldownMinutes) {
    var now = toMs(nowMs);
    if (!Number.isFinite(now)) return false;
    var cooldown = Math.max(0, Number(cooldownMinutes) || 0);
    if (cooldown === 0) return true;
    if (lastNotifiedAtMs === null || lastNotifiedAtMs === undefined) return true;
    var last = toMs(lastNotifiedAtMs);
    if (!Number.isFinite(last)) return true;
    if (now < last) return false; // clock moved backwards: stay quiet
    return now - last >= cooldown * 60 * 1000;
  }

  /* ------------------------------------------------------------------ */
  /* Weekly / rolling-window counting                                    */
  /*                                                                     */
  /* countInWindow(timestampsMs, nowMs, windowMs) counts sightings in    */
  /* (now - windowMs, now]. Default window is 7 days.                    */
  /* isRepeatSuspicious(count, threshold) is true once the count        */
  /* reaches the threshold — i.e. the alert fires on the Nth sighting    */
  /* in the window, where N is the user's threshold (default 3).         */
  /* ------------------------------------------------------------------ */
  function countInWindow(timestampsMs, nowMs, windowMs) {
    var now = toMs(nowMs);
    var window = windowMs === undefined ? SEVEN_DAYS_MS : Math.max(0, Number(windowMs) || 0);
    if (!Number.isFinite(now) || !Array.isArray(timestampsMs)) return 0;
    var count = 0;
    for (var i = 0; i < timestampsMs.length; i++) {
      var t = toMs(timestampsMs[i]);
      if (!Number.isFinite(t)) continue;
      if (t > now - window && t <= now) count++;
    }
    return count;
  }

  function isRepeatSuspicious(count, threshold) {
    var c = Math.max(0, Math.floor(Number(count) || 0));
    var th = Math.max(1, Math.floor(Number(threshold) || 1));
    return c >= th;
  }

  /* ------------------------------------------------------------------ */
  /* Crop signatures: average hash + colour histogram                    */
  /*                                                                     */
  /* averageHash(gray64): gray64 is an array of exactly 64 grayscale     */
  /* values (0-255), row-major, from an 8x8 downscale of the crop.      */
  /* Each bit is 1 when that pixel is brighter than the mean. A flat     */
  /* image (all pixels equal to the mean) hashes to all zeros.          */
  /*                                                                     */
  /* histogram(gray64): 8-bin normalised histogram (sums to 1).         */
  /*                                                                     */
  /* makeSignature(gray64) bundles both. signaturesMatch() requires     */
  /* BOTH the hash to be close (few bits differ) AND the histogram to    */
  /* be close. Either test alone is too weak; both together still only   */
  /* ever *suggest* a match for the user to confirm.                    */
  /* ------------------------------------------------------------------ */
  function averageHash(gray64) {
    if (!Array.isArray(gray64) || gray64.length !== 64) return null;
    var sum = 0;
    for (var i = 0; i < 64; i++) {
      var v = Number(gray64[i]);
      if (!Number.isFinite(v)) return null;
      sum += Math.max(0, Math.min(255, v));
    }
    var mean = sum / 64;
    var bits = "";
    for (var j = 0; j < 64; j++) {
      bits += Math.max(0, Math.min(255, Number(gray64[j]))) > mean ? "1" : "0";
    }
    return bits;
  }

  function histogram(gray64) {
    if (!Array.isArray(gray64) || gray64.length !== 64) return null;
    var bins = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < 64; i++) {
      var v = Number(gray64[i]);
      if (!Number.isFinite(v)) return null;
      var clamped = Math.max(0, Math.min(255, v));
      var bin = Math.min(7, Math.floor(clamped / 32));
      bins[bin]++;
    }
    return bins.map(function (b) { return b / 64; });
  }

  function makeSignature(gray64) {
    var hash = averageHash(gray64);
    var hist = histogram(gray64);
    if (hash === null || hist === null) return null;
    return { hash: hash, hist: hist };
  }

  function hammingDistance(hashA, hashB) {
    if (typeof hashA !== "string" || typeof hashB !== "string") return -1;
    if (hashA.length !== 64 || hashB.length !== 64) return -1;
    var d = 0;
    for (var i = 0; i < 64; i++) {
      if (hashA[i] !== hashB[i]) d++;
    }
    return d;
  }

  function histogramDistance(histA, histB) {
    if (!Array.isArray(histA) || !Array.isArray(histB)) return -1;
    if (histA.length !== 8 || histB.length !== 8) return -1;
    var total = 0;
    for (var i = 0; i < 8; i++) {
      var a = Number(histA[i]);
      var b = Number(histB[i]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
      total += Math.abs(a - b);
    }
    return total / 2; // normalised histograms: range 0..1
  }

  function signaturesMatch(sigA, sigB, options) {
    if (!sigA || !sigB) return false;
    var opts = options || {};
    var maxHamming = opts.maxHamming === undefined ? 10 : opts.maxHamming;
    var maxHist = opts.maxHist === undefined ? 0.35 : opts.maxHist;
    var ham = hammingDistance(sigA.hash, sigB.hash);
    var hist = histogramDistance(sigA.hist, sigB.hist);
    if (ham < 0 || hist < 0) return false;
    return ham <= maxHamming && hist <= maxHist;
  }

  /* Best stored signature for a new signature, or null. The caller
   * still has to ask the user to confirm — a match is a suggestion. */
  function findBestMatch(signature, stored, options) {
    if (!signature || !Array.isArray(stored)) return null;
    var best = null;
    var bestHam = Infinity;
    for (var i = 0; i < stored.length; i++) {
      var cand = stored[i];
      if (!cand || !cand.signature) continue;
      if (!signaturesMatch(signature, cand.signature, options)) continue;
      var ham = hammingDistance(signature.hash, cand.signature.hash);
      if (ham < bestHam) {
        bestHam = ham;
        best = cand;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Speech-queue dedupe decision (pure; the DOM queue lives in app.js)  */
  /*                                                                     */
  /* shouldQueueSpeech(text, lastSpoken, queue, nowMs) is true when a   */
  /* new utterance may be queued: the same text must not already be      */
  /* queued, and must not have been spoken within dedupeWindowMs        */
  /* (default 10 s). This is the guard that stops a repeated alert      */
  /* talking over itself; the per-person cooldown in shouldNotify is    */
  /* applied separately by the caller before speaking at all.            */
  /* ------------------------------------------------------------------ */
  function shouldQueueSpeech(text, lastSpoken, queue, nowMs, dedupeWindowMs) {
    if (typeof text !== "string" || !text.trim()) return false;
    var now = toMs(nowMs);
    if (!Number.isFinite(now)) return false;
    var window = dedupeWindowMs === undefined ? 10000 : Math.max(0, Number(dedupeWindowMs) || 0);
    if (lastSpoken && lastSpoken.text === text) {
      var at = toMs(lastSpoken.at);
      if (Number.isFinite(at) && now - at < window) return false;
    }
    if (Array.isArray(queue) && queue.indexOf(text) !== -1) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Event-snapshot expiry                                                 */
  /*                                                                     */
  /* snapshotExpired(capturedAtMs, nowMs, retentionHours, saved) is     */
  /* true when an UNSAVED event snapshot is older than the retention     */
  /* window. Saved snapshots never expire. snapshotTimeLeftMs()          */
  /* returns milliseconds left before expiry (0 when expired,           */
  /* Infinity for saved snapshots). The app sweeps expired snapshots     */
  /* on start and on a timer. This is the ONLY stored-image rule that   */
  /* allows pictures: event snapshots only (zone intrusions and         */
  /* suspicious activity). People-memory records still hold numbers     */
  /* only — see stripImageData().                                        */
  /* ------------------------------------------------------------------ */
  function snapshotExpired(capturedAtMs, nowMs, retentionHours, saved) {
    if (saved) return false;
    var captured = toMs(capturedAtMs);
    var now = toMs(nowMs);
    if (!Number.isFinite(captured) || !Number.isFinite(now)) return false;
    var retention = Math.max(0, Number(retentionHours) || 0);
    if (retention === 0) return true;
    return now - captured >= retention * 60 * 60 * 1000;
  }

  function snapshotTimeLeftMs(capturedAtMs, nowMs, retentionHours, saved) {
    if (saved) return Infinity;
    var captured = toMs(capturedAtMs);
    var now = toMs(nowMs);
    if (!Number.isFinite(captured) || !Number.isFinite(now)) return 0;
    var retention = Math.max(0, Number(retentionHours) || 0);
    var left = captured + retention * 60 * 60 * 1000 - now;
    return left > 0 ? left : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Save-boundary guard: no image data in stored records                 */
  /*                                                                     */
  /* stripImageData(record) returns a copy with every image-bearing      */
  /* field removed: any data: image URL string, and any field named      */
  /* crop / cropDataUrl / dataUrl / image / photo / thumbnail / preview */
  /* / previewDataUrl. The numeric signature, name, ids and timestamps  */
  /* pass through untouched. An enrollment preview (the one picture      */
  /* shown while the user is asked about someone/something new) may be   */
  /* shown on screen, but it must never be saved — callers run records   */
  /* through this before writing them to storage, AND discard the        */
  /* preview data itself the moment the prompt resolves, so no           */
  /* enrollment photo can survive saving or cancelling.                  */
  /* ------------------------------------------------------------------ */
  function stripImageData(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    var dropped = { crop: true, cropDataUrl: true, dataUrl: true, image: true, photo: true,
                    thumbnail: true, preview: true, previewDataUrl: true };
    var clean = {};
    Object.keys(record).forEach(function (k) {
      if (dropped[k]) return;
      var v = record[k];
      if (typeof v === "string" && /^data:image\//.test(v)) return;
      clean[k] = v;
    });
    return clean;
  }

  /* ------------------------------------------------------------------ */
  /* Hugging Face deployment + token masking (pure)                      */
  /*                                                                     */
  /* modelDeploymentLive(mapping) reads the inferenceProviderMapping    */
  /* from the public Hugging Face models API (GET /api/models/<id>      */
  /* ?expand[]=inferenceProviderMapping). The API returns it either as   */
  /* an object keyed by provider ({ "hf-inference": { status } }) or    */
  /* as an array of provider entries ([{ status }]). A model counts as   */
  /* callable only when at least one entry has status "live". An empty   */
  /* mapping means NO Inference Provider deploys the model — the model   */
  /* page says "This model isn't deployed by any Inference Provider" —  */
  /* and no inference call to it can work. "Connected" must mean this,   */
  /* not merely that the model's metadata page exists.                   */
  /*                                                                     */
  /* Verified 2026-11-23: facebook/detr-resnet-50 returns               */
  /* hf-inference status "live" (object-detection).                     */
  /* Salesforce/blip-image-captioning-base, -large,                      */
  /* nlpconnect/vit-gpt2-image-captioning and microsoft/git-base-coco   */
  /* all return an EMPTY mapping — none is deployed, so image            */
  /* descriptions are OFF by default and the app uses detection-only     */
  /* wording until the user enters a description model ID that IS        */
  /* deployed.                                                           */
  /*                                                                     */
  /* maskToken(token) is the ONLY form of a token the app may display:   */
  /* the first 3 characters, an ellipsis, and the last 4. The full      */
  /* token is never shown, logged, or written into the activity log.     */
  /* ------------------------------------------------------------------ */
  function modelDeploymentLive(mapping) {
    if (!mapping) return false;
    var entries = [];
    if (Array.isArray(mapping)) {
      entries = mapping;
    } else if (typeof mapping === "object") {
      entries = Object.keys(mapping).map(function (k) { return mapping[k]; });
    } else {
      return false;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && typeof e === "object" && e.status === "live") return true;
    }
    return false;
  }

  function maskToken(token) {
    if (typeof token !== "string") return "";
    var t = token.trim();
    if (!t) return "";
    if (t.length <= 8) return "••••";
    return t.slice(0, 3) + "…" + t.slice(-4);
  }

  /* ------------------------------------------------------------------ */
  /* Watch zones (normalised 0..1 coordinates)                           */
  /*                                                                     */
  /* A detection counts as "in the zone" when the centre of its box is   */
  /* inside the zone OR the boxes overlap at all. Centre-first keeps     */
  /* large boxes that mostly sit outside a zone from triggering it,      */
  /* while overlap covers small boxes straddling an edge.                */
  /* ------------------------------------------------------------------ */
  function pointInZone(x, y, zone) {
    if (!zone) return false;
    return x >= zone.x && x <= zone.x + zone.w &&
           y >= zone.y && y <= zone.y + zone.h;
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function detectionInZone(box, zone) {
    if (!box || !zone) return false;
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    if (pointInZone(cx, cy, zone)) return true;
    return rectsOverlap(box, zone);
  }

  function detectionInAnyZone(box, zones) {
    if (!Array.isArray(zones)) return null;
    for (var i = 0; i < zones.length; i++) {
      if (detectionInZone(box, zones[i])) return zones[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Vehicle "pass" debouncing                                           */
  /*                                                                     */
  /* One car driving past produces many consecutive frames with a car    */
  /* in them. Count it as ONE pass until no car has been seen for        */
  /* gapMs (default 8 seconds), then the next car frame is a new pass.  */
  /* ------------------------------------------------------------------ */
  function shouldCountNewPass(lastCarSeenAtMs, nowMs, gapMs) {
    var now = toMs(nowMs);
    if (!Number.isFinite(now)) return false;
    var gap = gapMs === undefined ? 8000 : Math.max(0, Number(gapMs) || 0);
    if (lastCarSeenAtMs === null || lastCarSeenAtMs === undefined) return true;
    var last = toMs(lastCarSeenAtMs);
    if (!Number.isFinite(last)) return true;
    return now - last > gap;
  }

  var api = {
    SEVEN_DAYS_MS: SEVEN_DAYS_MS,
    shouldNotify: shouldNotify,
    countInWindow: countInWindow,
    isRepeatSuspicious: isRepeatSuspicious,
    averageHash: averageHash,
    histogram: histogram,
    makeSignature: makeSignature,
    hammingDistance: hammingDistance,
    histogramDistance: histogramDistance,
    signaturesMatch: signaturesMatch,
    findBestMatch: findBestMatch,
    shouldQueueSpeech: shouldQueueSpeech,
    snapshotExpired: snapshotExpired,
    snapshotTimeLeftMs: snapshotTimeLeftMs,
    stripImageData: stripImageData,
    modelDeploymentLive: modelDeploymentLive,
    maskToken: maskToken,
    pointInZone: pointInZone,
    rectsOverlap: rectsOverlap,
    detectionInZone: detectionInZone,
    detectionInAnyZone: detectionInAnyZone,
    shouldCountNewPass: shouldCountNewPass
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.CameraWatchLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
