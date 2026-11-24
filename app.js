/* Camera Watch AI — browser app logic.
 *
 * Local-first: people, cars, zones, settings and the activity log live
 * in this browser's localStorage. The only network calls are (a) the
 * camera stream URL the user typed in, (b) Hugging Face Inference
 * API calls, made only when a saved token validated as connected,
 * and (c) the cheap connection check itself (whoami + model metadata,
 * no inference call, no camera frame) that runs when a token is saved
 * and when the app opens with a saved token. Descriptions are OFF by
 * default: no description model is currently verified as deployed by
 * any Inference Provider, so the app uses detection-only wording
 * unless the user enters a deployed description model ID.
 *
 * LIVE FEED FIRST — nothing recorded by watching itself. The AI watches
 * the running live video: each analysis frame is drawn from the live
 * video element to an offscreen canvas held in memory only, analysed,
 * and discarded. Watching alone stores nothing.
 *
 * ONE EXCEPTION — event snapshots: a single still frame is captured
 * from the live video ONLY when (a) a person is inside a watch zone,
 * or (b) suspicious activity is flagged (repeat-car question, an
 * unknown person lingering, motion + person inside a zone). That still
 * is shown with the alert and stored locally on the device only. It
 * auto-deletes 6 hours after capture (configurable) unless the user
 * taps Save on it. No continuous recording, no snapshots at any other
 * time, and event snapshots are never uploaded anywhere.
 *
 * A crop preview may be shown on screen while the user is naming
 * someone, but it is never saved: stored people-memory is ONLY the
 * numeric signature (hash + histogram numbers, see logic.js) plus the
 * name and timestamps. Every person/car record passes through
 * L.stripImageData() before it is written to storage.
 *
 * ENROLLMENT SNAPSHOTS ARE TRANSIENT ONLY — people and cars alike.
 * When the app meets someone or something new, it shows ONE frame from
 * the live feed next to the "Who is this?" / "Does this car live around
 * here?" question, saves ONLY the name/answer plus the numeric
 * signature and timestamps, and then DELETES the photo straight away —
 * on saving AND on cancelling. Enrollment photos are never written to
 * storage and never enter the event-snapshot gallery. Only
 * zone/suspicious stills are kept, and those delete after 6 hours
 * unless saved (see captureEventSnapshot).
 *
 * Nothing here identifies a stranger. Every match is a suggestion the
 * user confirms or corrects.
 */
(function () {
  "use strict";

  var L = window.CameraWatchLogic;
  if (!L) {
    document.body.insertAdjacentHTML("afterbegin",
      "<p style='padding:12px'>logic.js failed to load. The app cannot run.</p>");
    return;
  }

  /* ---------------- storage ---------------- */
  var KEYS = {
    settings: "cwa_settings",
    people: "cwa_people",
    cars: "cwa_cars",
    feed: "cwa_feed",
    zones: "cwa_zones",
    snapshots: "cwa_snapshots",
    lastNotified: "cwa_last_notified",
    hfStatus: "cwa_hf_status", // connection state only — never the token itself
    setupCollapsed: "cwa_setup_collapsed"
  };
  var MAX_SNAPSHOTS = 20; // local-only event stills; oldest unsaved go first

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/blocked: keep running in memory */ }
  }
  /* People/cars are ALWAYS saved through stripImageData: no picture,
   * crop, or data: URL can ever reach storage. Only the numeric
   * signature, the name, and timestamps are kept. */
  function savePeople() {
    saveJson(KEYS.people, people.map(function (p) { return L.stripImageData(p); }));
  }
  function saveCars() {
    saveJson(KEYS.cars, cars.map(function (c) { return L.stripImageData(c); }));
  }
  function uid() {
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function timeStr(ms) { return new Date(ms).toLocaleString(); }

  var DEFAULT_SETTINGS = {
    hfToken: "",
    detectModel: "facebook/detr-resnet-50",
    /* Descriptions default OFF (empty): the previous default,
     * Salesforce/blip-image-captioning-base, is NOT deployed by any
     * Inference Provider — its model page says so, and the public
     * models API returns an empty inferenceProviderMapping for it
     * (checked 2026-11-23, along with -large, vit-gpt2 captioning
     * and git-base-coco). The user can type in a description model
     * ID that IS deployed; until then the app uses plain
     * detection-based wording ("Sees: person, car"). */
    captionModel: "",
    cooldownMinutes: 30,
    repeatThreshold: 3,
    zonesEnabled: true,
    voiceEnabled: true,
    motionSensitivity: 25,
    sampleFps: 1, // live-feed analysis frames per second (in-memory only)
    speakAlerts: true, // spoken alerts out loud while watching
    speakMode: "alerts", // "alerts" = alerts only; "all" = alerts + info
    speechVoice: "", // empty = the device default voice
    speechRate: 1,
    snapshotRetentionHours: 6 // event snapshots auto-delete after this, unless saved
  };
  var HF_MIN_INTERVAL_MS = 3000; // don't hammer the free Inference API
  var CAR_LABELS = { car: true, truck: true, bus: true };

  var settings = Object.assign({}, DEFAULT_SETTINGS, loadJson(KEYS.settings, {}));
  /* The shipped caption default turned out not to be deployed by any
   * Inference Provider. Browsers that saved it get the new default
   * (descriptions off) instead of a model ID that can never answer. */
  if (settings.captionModel === "Salesforce/blip-image-captioning-base") {
    settings.captionModel = "";
    saveJson(KEYS.settings, settings);
  }
  var people = loadJson(KEYS.people, []);
  var cars = loadJson(KEYS.cars, []);
  var snapshots = loadJson(KEYS.snapshots, []);
  /* Records stored by an earlier build could still hold a crop image;
   * drop any image data at load so nothing stored survives in memory. */
  people = people.map(function (p) { return L.stripImageData(p); });
  cars = cars.map(function (c) { return L.stripImageData(c); });
  var feed = loadJson(KEYS.feed, []);
  var zones = loadJson(KEYS.zones, []);
  var lastNotified = loadJson(KEYS.lastNotified, {}); // subjectKey -> epoch ms

  /* ---------------- DOM ---------------- */
  function $(id) { return document.getElementById(id); }
  var els = {};
  ["setupCard", "setupToggleBtn", "setupStep1", "setupStep2", "setupStep3",
   "setupStep1Note", "setupStep2Note", "setupStep3Note",
   "setupStep1Btn", "setupStep2Btn", "setupStep3Btn",
   "modeBadge", "sourceSelect", "wifiFields", "streamType", "streamUrl",
   "startPhoneBtn", "connectStreamBtn", "stopCameraBtn", "cameraStatus",
   "liveBadge", "liveNote",
   "previewWrap", "phoneVideo", "streamImg", "overlayCanvas",
   "notifyPermBtn", "notifyStatus", "alertSnapshotArea",
   "drawZoneBtn", "clearZonesBtn", "labelNowBtn", "zonesList", "motionStatus",
   "lastDescription", "identifyArea", "carQuestionArea", "knownChip",
   "micBtn", "stopVoiceBtn", "voiceStatus", "voiceAnswer",
   "peopleList", "carsList", "feedList", "clearFeedBtn", "snapshotList",
   "setHfToken", "clearTokenBtn", "setDetectModel", "setCaptionModel",
   "setCooldown", "setThreshold", "setSensitivity", "setSampleFps", "setRetentionHours", "zonesEnabled",
   "voiceEnabled", "speakAlerts", "speakMode", "speechVoice", "speechRate",
   "saveSettingsBtn", "clearAllBtn", "settingsStatus"
  ].forEach(function (id) { els[id] = $(id); });

  /* ---------------- feed ---------------- */
  function addFeed(kind, text) {
    feed.unshift({ at: Date.now(), kind: kind, text: text });
    if (feed.length > 200) feed.length = 200;
    saveJson(KEYS.feed, feed);
    renderFeed();
    if (kind === "alert") maybeNotify("Tweaker Camera", text);
  }
  function renderFeed() {
    /* Header mission-status readout: how many alerts have been raised.
     * Presentation only — counted from the feed on every render. */
    var alertCountEl = $("alertCount");
    if (alertCountEl) {
      var alertTotal = 0;
      for (var i = 0; i < feed.length; i++) {
        if (feed[i].kind === "alert") alertTotal++;
      }
      alertCountEl.textContent = (alertTotal < 10 ? "0" : "") + alertTotal;
    }
    if (!feed.length) {
      els.feedList.innerHTML = "<li class='muted'>Nothing yet. Start a camera.</li>";
      return;
    }
    els.feedList.innerHTML = feed.map(function (e) {
      return "<li><time>" + esc(timeStr(e.at)) + " — " + esc(e.kind) + "</time>" +
        esc(e.text) + "</li>";
    }).join("");
  }

  /* ---------------- event snapshots ----------------
   * ONE still from the live feed, only for (a) a person inside a watch
   * zone or (b) suspicious activity (repeat-car flag, unknown person
   * lingering, motion + person in a zone). Captured from the in-memory
   * frame canvas at the moment of the event, stored locally on the
   * device only, never uploaded. Auto-deletes after
   * settings.snapshotRetentionHours (default 6) unless the user saves
   * it. No continuous recording; watching alone stores nothing. */
  function saveSnapshots() {
    saveJson(KEYS.snapshots, snapshots);
  }

  function snapshotAgeText(atMs, nowMs) {
    var mins = Math.max(0, Math.floor((nowMs - atMs) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hours = Math.floor(mins / 60);
    return hours + " hr " + (mins % 60) + " min ago";
  }

  function snapshotLeftText(snap, nowMs) {
    if (snap.saved) return "saved";
    var left = L.snapshotTimeLeftMs(snap.at, nowMs, settings.snapshotRetentionHours, false);
    if (left <= 0) return "expired";
    var mins = Math.ceil(left / 60000);
    if (mins < 60) return "deletes in " + mins + " min";
    return "deletes in " + Math.floor(mins / 60) + " hr " + (mins % 60) + " min";
  }

  function snapshotCardHtml(snap) {
    var now = Date.now();
    return "<div class='snapshot-card'>" +
      "<img src='" + esc(snap.dataUrl || "") + "' alt='Saved picture from the live feed'>" +
      "<div class='who'><b>" + esc(snap.label || "Saved picture") + "</b>" +
      "<div class='muted'>" + esc(snap.reason || "") + "<br>" +
      esc(timeStr(snap.at)) + " · " + esc(snapshotAgeText(snap.at, now)) + "<br>" +
      esc(snapshotLeftText(snap, now)) + "</div>" +
      "<div class='row' style='margin-top:6px'>" +
      (snap.saved
        ? "<span class='chip'>Saved</span>"
        : "<button type='button' data-save-snapshot='" + esc(snap.id) + "' class='primary'>Save</button>") +
      "<button type='button' data-delete-snapshot='" + esc(snap.id) + "' class='danger'>Delete</button>" +
      "</div></div></div>";
  }

  function renderSnapshots() {
    if (!snapshots.length) {
      els.snapshotList.innerHTML = "<p class='muted'>No saved pictures. One is saved " +
        "only for a zone event or a strange event. You still hear about every person. " +
        "Unsaved pictures delete after " + settings.snapshotRetentionHours + " hours.</p>";
      return;
    }
    els.snapshotList.innerHTML = snapshots.map(snapshotCardHtml).join("");
  }

  function sweepSnapshots(quiet) {
    var now = Date.now();
    var before = snapshots.length;
    snapshots = snapshots.filter(function (s) {
      return !L.snapshotExpired(s.at, now, settings.snapshotRetentionHours, s.saved);
    });
    if (snapshots.length !== before) {
      saveSnapshots();
      renderSnapshots();
      if (!quiet) addFeed("system", (before - snapshots.length) + " old picture(s) deleted.");
    }
    return before - snapshots.length;
  }

  function pruneSnapshots() {
    // Cap the local store: oldest unsaved first; oldest saved only if all are saved.
    while (snapshots.length > MAX_SNAPSHOTS) {
      var idx = -1;
      for (var i = snapshots.length - 1; i >= 0; i--) {
        if (!snapshots[i].saved) { idx = i; break; }
      }
      if (idx === -1) idx = snapshots.length - 1;
      snapshots.splice(idx, 1);
    }
  }

  function captureEventSnapshot(kind, reason, label) {
    // ONE still from the CURRENT live frame. Never called except for a
    // zone intrusion or a suspicious-activity flag.
    var dataUrl = null;
    try { dataUrl = frameCanvas.toDataURL("image/jpeg", 0.8); } catch (e) { return null; }
    if (!dataUrl) return null;
    var snap = {
      id: uid(), at: Date.now(), kind: kind, reason: reason,
      label: label || "Saved picture", saved: false, dataUrl: dataUrl
    };
    snapshots.unshift(snap);
    pruneSnapshots();
    saveSnapshots();
    renderSnapshots();
    addFeed("alert", "Picture saved on this phone only: " + reason + ". It deletes after " +
      settings.snapshotRetentionHours + " hours unless you save it.");
    return snap;
  }

  function showAlertSnapshot(snap, heading) {
    if (!snap) return;
    els.alertSnapshotArea.innerHTML =
      "<div class='card warnbox'><h2>" + esc(heading || "Picture saved") + "</h2>" +
      "<p>" + esc(snap.reason || "") + " — spoken out loud and shown here. " +
      "This one picture stays on this phone only. It deletes after " +
      settings.snapshotRetentionHours + " hours unless you save it.</p>" +
      snapshotCardHtml(snap) + "</div>";
  }

  /* ---------------- speech ----------------
   * Spoken notifications OUT LOUD while watching the live feed.
   *
   * One utterance queue, in order, no overlapping speech: utterances
   * are spoken one at a time and the next starts only when the previous
   * ends. Identical text already queued or spoken in the last 10
   * seconds is dropped, so a repeated alert never talks over itself.
   *
   * Cooldowns are respected upstream: callers only call speak() for an
   * alert after the per-person/zone cooldown check passed, so a person
   * already announced inside the cooldown window is not spoken about
   * again. The queue dedupe is a second guard, not the cooldown.
   *
   * Kinds: "alert" (zone movement, a named/unknown person, repeat-car
   * question) and "info" (answers to voice questions, confirmations).
   * speakAlerts off silences alerts; speakMode "alerts" (default) speaks
   * alerts only, "all" also speaks info. voiceEnabled off silences
   * everything spoken. */
  var speakQueue = [];
  var speakActive = false;
  var lastSpoken = { text: "", at: 0 };

  function speak(text, kind) {
    if (!settings.voiceEnabled) return;
    if (!("speechSynthesis" in window)) return;
    var k = kind || "alert";
    if (k === "alert" && !settings.speakAlerts) return;
    if (k === "info" && settings.speakMode !== "all") return;
    text = String(text || "").trim();
    if (!L.shouldQueueSpeech(text, lastSpoken, speakQueue, Date.now())) return;
    speakQueue.push(text);
    pumpSpeech();
  }

  function pumpSpeech() {
    if (speakActive) return;
    var text = speakQueue.shift();
    if (text === undefined) return;
    speakActive = true;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = settings.speechRate || 1;
      var voice = pickSpeechVoice();
      if (voice) u.voice = voice;
      u.onend = u.onerror = function () {
        lastSpoken = { text: text, at: Date.now() };
        speakActive = false;
        pumpSpeech();
      };
      window.speechSynthesis.speak(u);
    } catch (e) {
      speakActive = false;
      pumpSpeech();
    }
  }

  function pickSpeechVoice() {
    if (!settings.speechVoice) return null;
    try {
      var voices = window.speechSynthesis.getVoices() || [];
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].name === settings.speechVoice || voices[i].voiceURI === settings.speechVoice) return voices[i];
      }
    } catch (e) { /* fall through to the default voice */ }
    return null;
  }

  function stopSpeaking() {
    speakQueue.length = 0;
    speakActive = false;
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  }

  function populateVoiceList() {
    if (!("speechSynthesis" in window)) return;
    var select = els.speechVoice;
    if (!select) return;
    var voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (e) {}
    var current = select.value || settings.speechVoice || "";
    select.innerHTML = "<option value=''>Default voice</option>" +
      voices.map(function (v) {
        return "<option value='" + esc(v.name) + "'" + (v.name === current ? " selected" : "") + ">" +
          esc(v.name) + (v.lang ? " (" + esc(v.lang) + ")" : "") + "</option>";
      }).join("");
    if (current) select.value = current;
  }
  function updateVoiceStatus() {
    var ok = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
    els.voiceStatus.textContent = !settings.voiceEnabled
      ? "Voice is off (see Settings)."
      : ok ? "Voice is on. Tap the microphone and ask a question."
      : "This browser can't do voice. Spoken alerts still work.";
    els.micBtn.disabled = !settings.voiceEnabled || !ok;
  }

  var recognition = null;
  function startListening() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { els.voiceStatus.textContent = "This browser can't do voice."; return; }
    if (recognition) { try { recognition.stop(); } catch (e) {} }
    recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = function (ev) {
      var heard = ev.results[0][0].transcript || "";
      els.voiceStatus.textContent = "Heard: " + heard;
      answerQuestion(heard);
    };
    recognition.onerror = function (ev) {
      els.voiceStatus.textContent = "Listening failed.";
    };
    recognition.onend = function () { recognition = null; };
    try { recognition.start(); els.voiceStatus.textContent = "Listening…"; }
    catch (e) { els.voiceStatus.textContent = "Could not start listening."; }
  }

  function answerQuestion(text) {
    var q = String(text || "").toLowerCase();
    var answer;
    var now = Date.now();
    var todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    if (q.indexOf("who was here") !== -1 || q.indexOf("who has been here") !== -1) {
      var seen = people.filter(function (p) {
        return (p.sightings || []).some(function (t) { return t >= todayStart.getTime(); });
      }).map(function (p) { return p.name; });
      answer = seen.length
        ? "Today I have seen: " + seen.join(", ") + "."
        : "No one I know has been on camera today.";
    } else if (q.indexOf("repeat car") !== -1 || q.indexOf("cars this week") !== -1 || q.indexOf("suspicious") !== -1) {
      var repeats = cars.filter(function (c) {
        return L.isRepeatSuspicious(L.countInWindow(c.sightings || [], now), settings.repeatThreshold);
      });
      answer = repeats.length
        ? repeats.length + " car" + (repeats.length === 1 ? "" : "s") +
          " passed at least " + settings.repeatThreshold + " times in the last 7 days."
        : "No car has passed " + settings.repeatThreshold + " times in the last 7 days.";
    } else if (q.indexOf("how many cars") !== -1) {
      var total = cars.reduce(function (n, c) {
        return n + L.countInWindow(c.sightings || [], now);
      }, 0);
      answer = total + " car passes in the last 7 days.";
    } else if (q.indexOf("what do you see") !== -1 || q.indexOf("what is happening") !== -1) {
      answer = els.lastDescription.textContent || "Nothing analysed yet.";
    } else {
      answer = "I can answer: who was here today, any repeat cars this week, how many cars, or what do you see.";
    }
    els.voiceAnswer.textContent = answer;
    addFeed("answer", "Asked: \"" + text + "\" — " + answer);
    speak(answer, "info");
  }

  /* ---------------- staying awake & background honesty ----------------
   *
   * A browser page CANNOT keep the camera running once the app is fully
   * backgrounded or the phone is locked — the browser stops camera
   * access and throttles timers. What this build honestly does:
   *   1. Screen Wake Lock while the watch page is visible, so the
   *      phone does not fall asleep mid-watch.
   *   2. Web Notifications as a companion, so an alert can still
   *      surface when the page is hidden (the camera itself is paused
   *      by the browser in that state — the notification only carries
   *      alerts raised while the page was last visible).
   * True background watching needs the native Android foreground
   * service. The hook is backgroundWatch below: it activates ONLY when
   * a native ForegroundService plugin is present (Capacitor build),
   * and otherwise degrades gracefully to wake-lock + notifications.
   * See docs/build-apk.md for the integration point. Never claim the
   * browser build watches in the background. */
  var wakeLock = null;
  var backgroundWatch = {
    nativeForegroundService: false,
    supported: function () { return this.nativeForegroundService; }
  };
  // Documented hook for the native build; harmless in the browser.
  window.CameraWatchBackground = backgroundWatch;

  function detectNativeBackgroundWatch() {
    try {
      var plugins = window.Capacitor && window.Capacitor.Plugins;
      backgroundWatch.nativeForegroundService = Boolean(plugins && plugins.ForegroundService);
    } catch (e) { backgroundWatch.nativeForegroundService = false; }
  }

  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        wakeLock = lock;
        wakeLock.addEventListener("release", function () { wakeLock = null; });
      }).catch(function () { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  function maybeNotify(title, body) {
    // Companion only: surfaces alerts when the page is hidden. The
    // browser still pauses the camera while hidden; this does not
    // keep watching in the background.
    if (!document.hidden) return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try { new Notification(title, { body: body }); } catch (e) { /* notifications unavailable */ }
  }

  function updateNotifyStatus() {
    if (!els.notifyStatus) return;
    if (!("Notification" in window)) {
      els.notifyStatus.textContent = "This browser can't do alerts.";
      return;
    }
    els.notifyStatus.textContent =
      Notification.permission === "granted"
        ? "Alerts allowed. They pop up when this page is hidden. The camera still stops when hidden — real background watching needs the Android app."
        : Notification.permission === "denied"
        ? "Alerts are blocked in browser settings. Spoken alerts still work while the page is open."
        : "Alerts not allowed yet. Tap the button to allow them.";
  }

  /* ---------------- Hugging Face auto-connect ----------------
   *
   * The models connect THEMSELVES the moment a token is saved: saving
   * Settings runs validateHfConnection(), and opening the app with a
   * saved token validates again. No extra button, no extra step.
   *
   * Validation is cheap and burns NO inference call and NO camera
   * frame: (1) GET /api/whoami with the token proves the token works;
   * (2) GET /api/models/<id>?expand[]=inferenceProviderMapping proves
   * each configured model is actually deployed (a "live" provider
   * entry). "Connected" therefore means callable — a model whose
   * metadata exists but has no live provider is reported as
   * unavailable for that half, never as connected. On failure the app
   * stays in local-only (or detection-only) mode and does NOT retry
   * in a loop; saving Settings again is the only re-check.
   *
   * The full token is NEVER displayed, logged, or put in the feed:
   * status text uses only L.maskToken() ("hf_…last4").
   *
   * If watching is already running when validation succeeds, the live
   * analysis loop picks the models up at once: maybeAnalyseFrame()
   * reads hfDetectionReady()/hfCaptionsReady() on every sample. */
  var hfStatus = Object.assign(
    { token: "none", detection: "unknown", captions: "off", checkedAt: 0 },
    loadJson(KEYS.hfStatus, {})
  );
  var hfChecking = null; // in-flight validation promise, if any

  function saveHfStatus() {
    saveJson(KEYS.hfStatus, {
      token: hfStatus.token, detection: hfStatus.detection,
      captions: hfStatus.captions, checkedAt: hfStatus.checkedAt
    });
  }

  function hfDetectionReady() {
    return hfStatus.token === "valid" && hfStatus.detection === "live";
  }
  function hfCaptionsReady() {
    return hfStatus.token === "valid" && hfStatus.captions === "live";
  }

  function hfStatusSummary() {
    // Plain-words, per-half status. Never a blanket "Connected"
    // unless both configured halves are actually callable.
    if (!settings.hfToken) return { badge: "Local only — no token", hf: false };
    if (hfStatus.token === "checking") return { badge: "Checking token…", hf: true };
    if (hfStatus.token === "invalid") return { badge: "Token did not work — local only", hf: false };
    if (hfStatus.token === "error") return { badge: "Could not reach Hugging Face — local only", hf: false };
    if (hfStatus.token !== "valid") return { badge: "Not checked yet", hf: false };
    var det = hfStatus.detection === "live";
    var cap = hfStatus.captions === "live";
    if (det && cap) return { badge: "Finding + describing on", hf: true };
    if (det && hfStatus.captions === "off") return { badge: "Finding on — describing off", hf: true };
    if (det) return { badge: "Finding on — describing off", hf: true };
    return { badge: "Finding off — local only", hf: false };
  }

  function renderModeBadge() {
    var s = hfStatusSummary();
    els.modeBadge.textContent = s.badge;
    els.modeBadge.classList.toggle("hf", s.hf);
  }

  function renderHfSettingsStatus(extra) {
    var masked = L.maskToken(settings.hfToken);
    var base;
    if (!settings.hfToken) {
      base = "No token. Local only. Save a good token and the models connect by themselves.";
    } else if (hfStatus.token === "checking") {
      base = "Checking the token (" + masked + "). No camera picture is sent for this check.";
    } else if (hfStatus.token === "invalid") {
      base = "That token (" + masked + ") did not work. Check it and save again. Local only for now.";
    } else if (hfStatus.token === "error") {
      base = "Could not reach Hugging Face (" + masked + "). Save again to retry. Local only for now.";
    } else if (hfStatus.token === "valid") {
      var parts = ["Connected as " + masked + ":"];
      parts.push(hfStatus.detection === "live"
        ? "finding (" + settings.detectModel + ") is on"
        : "finding (" + settings.detectModel + ") is off — that model is not running");
      if (hfStatus.captions === "live") {
        parts.push("describing (" + settings.captionModel + ") is on");
      } else if (hfStatus.captions === "off") {
        parts.push("describing is off — no model set, so plain words are used");
      } else {
        parts.push("describing (" + settings.captionModel + ") is off — that model is not running");
      }
      base = parts.join(". ") + ".";
    } else {
      base = "Not checked yet. Save to connect.";
    }
    els.settingsStatus.textContent = extra ? extra + " " + base : base;
  }

  function hfModelMeta(modelId) {
    return fetch("https://huggingface.co/api/models/" + encodeURIComponent(modelId) + "?expand[]=inferenceProviderMapping", {
      headers: { Authorization: "Bearer " + settings.hfToken }
    }).then(function (res) {
      if (res.status === 404) return { deployed: false };
      if (!res.ok) throw new Error("Hugging Face returned HTTP " + res.status + " for " + modelId + ".");
      return res.json().then(function (meta) {
        return { deployed: L.modelDeploymentLive(meta && meta.inferenceProviderMapping) };
      });
    });
  }

  function validateHfConnection(opts) {
    opts = opts || {};
    if (!settings.hfToken) {
      hfStatus = { token: "none", detection: "unknown", captions: "off", checkedAt: Date.now() };
      saveHfStatus();
      renderModeBadge();
      renderHfSettingsStatus();
      renderSetupCard();
      return Promise.resolve(hfStatus);
    }
    if (hfChecking) return hfChecking; // one check at a time; no retry loop
    var tokenAtStart = settings.hfToken;
    hfStatus.token = "checking";
    renderModeBadge();
    renderHfSettingsStatus();
    renderSetupCard();
    hfChecking = fetch("https://huggingface.co/api/whoami", {
      headers: { Authorization: "Bearer " + tokenAtStart }
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        hfStatus = { token: "invalid", detection: "unavailable", captions: "unavailable", checkedAt: Date.now() };
        saveHfStatus();
        return hfStatus;
      }
      if (!res.ok) throw new Error("Hugging Face returned HTTP " + res.status + ".");
      hfStatus.token = "valid";
      var jobs = [hfModelMeta(settings.detectModel)];
      if (settings.captionModel) jobs.push(hfModelMeta(settings.captionModel));
      return Promise.all(jobs).then(function (results) {
        hfStatus.detection = results[0].deployed ? "live" : "unavailable";
        hfStatus.captions = settings.captionModel
          ? (results[1].deployed ? "live" : "unavailable")
          : "off";
        hfStatus.checkedAt = Date.now();
        saveHfStatus();
        return hfStatus;
      });
    }).catch(function (err) {
      // Network/API failure: report it once, stay local-only, no retries.
      hfStatus = { token: "error", detection: "unknown", captions: settings.captionModel ? "unknown" : "off", checkedAt: Date.now() };
      saveHfStatus();
      if (opts.announce) addFeed("system", "Hugging Face check failed: " + err.message + " Local-only mode for now; save Settings again to try once more.");
      return hfStatus;
    }).then(function (st) {
      hfChecking = null;
      // The token changed while this check was running: the result is
      // stale — validate the current token once instead of trusting it.
      if (settings.hfToken !== tokenAtStart) return validateHfConnection(opts);
      renderModeBadge();
      renderHfSettingsStatus();
      renderSetupCard();
      if (opts.announce) {
        if (st.token === "invalid") {
          addFeed("system", "Hugging Face token did not connect — Hugging Face rejected it. Local-only mode.");
        } else if (st.token === "valid") {
          var s = hfStatusSummary();
          addFeed("system", "Hugging Face auto-connect: " + s.badge + ".");
        }
      }
      return st;
    });
    return hfChecking;
  }

  /* ---------------- people & cars rendering ---------------- */
  function renderPeople() {
    if (!people.length) {
      els.peopleList.innerHTML = "<p class='muted'>Nobody remembered yet. A new person " +
        "gets asked about, then remembered.</p>";
      return;
    }
    els.peopleList.innerHTML = people.map(function (p) {
      var sightings = (p.sightings || []).length;
      /* No picture is stored or shown: only the name and the number
       * signature behind it. The initial of the name stands in for a photo. */
      return "<div class='person'><span class='avatar-initial' aria-hidden='true'>" + esc((p.name || "?").charAt(0).toUpperCase()) + "</span>" +
        "<div class='who'><b>" + esc(p.name) + "</b>" +
        "<div class='muted'>First seen " + esc(timeStr(p.firstSeen)) + "<br>Last seen " +
        esc(timeStr(p.lastSeen)) + " · " + sightings + " sighting" + (sightings === 1 ? "" : "s") +
        (p.confirmed ? "" : " · name not confirmed yet") + "</div>" +
        "<div class='row' style='margin-top:6px'>" +
        "<button type='button' data-rename-person='" + esc(p.id) + "'>Rename</button>" +
        "<button type='button' data-forget-person='" + esc(p.id) + "' class='danger'>Forget</button>" +
        "</div></div></div>";
    }).join("");
  }

  function renderCars() {
    if (!cars.length) {
      els.carsList.innerHTML = "<p class='muted'>No cars recorded yet.</p>";
      return;
    }
    var now = Date.now();
    els.carsList.innerHTML = cars.map(function (c) {
      var weekCount = L.countInWindow(c.sightings || [], now);
      var status = c.livesNearby === true ? "You said it lives around here."
        : c.livesNearby === false ? "You said it does not live around here."
        : "Not asked yet.";
      /* No picture is stored or shown for cars either — only the
       * number signature and the sighting history. */
      return "<div class='car'><span class='avatar-initial' aria-hidden='true'>CAR</span>" +
        "<div class='who'><b>Unknown car</b>" +
        "<div class='muted'>" + weekCount + " pass" + (weekCount === 1 ? "" : "es") +
        " in the last 7 days · first seen " + esc(timeStr(c.firstSeen)) + "<br>" + esc(status) + "</div>" +
        "<div class='row' style='margin-top:6px'>" +
        "<button type='button' data-forget-car='" + esc(c.id) + "' class='danger'>Forget this car</button>" +
        "</div></div></div>";
    }).join("");
  }

  function renderZones() {
    if (!zones.length) {
      els.zonesList.innerHTML = "<p class='muted'>No zones. Draw one on the live picture.</p>";
      return;
    }
    els.zonesList.innerHTML = zones.map(function (z, i) {
      return "<span class='chip'>" + esc(z.name || ("Zone " + (i + 1))) +
        " <button type='button' data-delete-zone='" + esc(z.id) + "' style='padding:2px 8px'>✕</button></span>";
    }).join("");
  }

  /* ---------------- camera ---------------- */
  var stream = null;          // MediaStream for the phone camera
  var stillTimer = null;      // interval id for still-refresh fallback polling
  var sampleTimer = null;     // interval id for live-feed frame sampling
  var activeSource = null;    // 'phone' | 'wifi' | null
  var frameCanvas = document.createElement("canvas");
  var prevGray = null;        // 32x24 grayscale of previous frame
  var prevMotionAt = 0;
  var lastHfAt = 0;
  var hfBusy = false;
  var frameBlocked = false;   // true when CORS blocks reading camera pixels
  var lastDetections = [];    // {box, label} for the overlay, with expiry
  var pendingSignatures = []; // signatures already awaiting a name (avoid duplicates)
  var drawMode = false;
  var drawingRect = null;

  function currentSourceElement() {
    if (activeSource === "phone") return els.phoneVideo;
    if (activeSource === "wifi") {
      var t = els.streamType.value;
      return t === "hls" ? els.phoneVideo : els.streamImg;
    }
    return null;
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(function (tr) { try { tr.stop(); } catch (e) {} }); stream = null; }
    if (stillTimer) { clearInterval(stillTimer); stillTimer = null; }
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    releaseWakeLock();
    stopSpeaking();
    try { els.phoneVideo.pause(); } catch (e) {}
    els.phoneVideo.removeAttribute("src");
    els.phoneVideo.srcObject = null;
    els.streamImg.removeAttribute("src");
    els.phoneVideo.style.display = "none";
    els.streamImg.style.display = "none";
    activeSource = null;
    prevGray = null;
    frameBlocked = false;
    els.liveBadge.hidden = true;
    els.cameraStatus.textContent = "No camera connected.";
    clearOverlay();
    renderSetupCard(); // step 3 is undone again once the camera stops
  }

  function startSampling() {
    // Live-feed sampling: frames are drawn from the running video to an
    // in-memory canvas and discarded after analysis. Default 1 fps.
    if (sampleTimer) clearInterval(sampleTimer);
    var fps = Math.max(0.25, Math.min(4, Number(settings.sampleFps) || 1));
    sampleTimer = setInterval(sampleFrame, Math.round(1000 / fps));
  }

  function showLiveBadge() {
    els.liveBadge.hidden = false;
  }

  function startPhoneCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.cameraStatus.textContent = "This browser can't use a camera. Use a Wi-Fi camera address.";
      return;
    }
    stopCamera();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (s) {
        stream = s;
        activeSource = "phone";
        els.phoneVideo.srcObject = s;
        els.phoneVideo.style.display = "block";
        return els.phoneVideo.play();
      })
      .then(function () {
        els.cameraStatus.textContent = "Phone camera on. Watching live.";
        showLiveBadge();
        requestWakeLock();
        addFeed("system", "Phone camera started. Watching the live feed; watching alone records nothing.");
        startSampling();
        maybeAutoCollapseSetupCard();
      })
      .catch(function (err) {
        els.cameraStatus.textContent = "Camera blocked: " + (err && err.name ? err.name : "unknown error") + ".";
        addFeed("system", "Phone camera failed to start: " + (err && err.message ? err.message : err));
      });
  }

  function connectStream() {
    var url = els.streamUrl.value.trim();
    if (!url) { els.cameraStatus.textContent = "Type your camera's web address first."; return; }
    stopCamera();
    activeSource = "wifi";
    var type = els.streamType.value;
    if (type === "mjpeg") {
      els.streamImg.style.display = "block";
      els.streamImg.src = url;
      showLiveBadge();
      els.cameraStatus.textContent = "Live stream on. Watching saves nothing.";
    } else if (type === "snapshot") {
      // Still-refresh FALLBACK, honestly labelled: this camera only
      // offers still pictures, so the live picture is refreshed as fast
      // as the camera allows. It is not a true video stream, and no
      // still is ever saved.
      els.streamImg.style.display = "block";
      var load = function () {
        var sep = url.indexOf("?") === -1 ? "?" : "&";
        els.streamImg.src = url + sep + "t=" + Date.now();
      };
      load();
      stillTimer = setInterval(load, 2000);
      showLiveBadge();
      els.cameraStatus.textContent = "Stills only. New picture every 2 seconds. Not live video. Nothing is saved.";
    } else { // hls
      els.phoneVideo.style.display = "block";
      els.phoneVideo.src = url;
      els.phoneVideo.play().catch(function () {
        els.cameraStatus.textContent = "That video did not play. Safari plays it. Other browsers may not.";
      });
      showLiveBadge();
      els.cameraStatus.textContent = "Connecting…";
    }
    els.streamImg.onerror = function () {
      els.cameraStatus.textContent = "That address did not load. Check it, and that the camera lets this page in.";
    };
    addFeed("system", "Wi-Fi camera connected (" + type + "). Watching the live feed; watching alone records nothing.");
    requestWakeLock();
    startSampling();
    maybeAutoCollapseSetupCard();
  }

  /* ---------------- frame sampling & motion ---------------- */
  function drawSourceToCanvas(el, canvas, w, h) {
    var vw = el.videoWidth || el.naturalWidth || 0;
    var vh = el.videoHeight || el.naturalHeight || 0;
    if (!vw || !vh) return false;
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(el, 0, 0, w, h);
    return true;
  }

  /* One live-feed sample: draw the CURRENT frame of the running live
   * video into the in-memory canvas, check motion, optionally send it
   * to Hugging Face, then discard it. The canvas is reused every
   * sample; no frame is ever written to disk or storage. */
  function sampleFrame() {
    var el = currentSourceElement();
    if (!el) return;
    if (el.readyState !== undefined && el.tagName === "VIDEO" && el.readyState < 2) return;
    if (el.tagName === "IMG" && !el.complete) return;
    var ok;
    try {
      ok = drawSourceToCanvas(el, frameCanvas, 320, 240);
      // Reading pixels throws / taints when the camera blocks cross-origin access.
      frameCanvas.getContext("2d").getImageData(0, 0, 1, 1);
    } catch (e) {
      if (!frameBlocked) {
        frameBlocked = true;
        els.cameraStatus.textContent = "Live view only. This camera blocks picture checks, so motion and AI are off.";
        addFeed("system", "Frame access blocked by the camera (CORS). Live view only; no analysis.");
      }
      return;
    }
    frameBlocked = false;
    var motion = computeMotion(frameCanvas);
    if (motion.ratio > 0.02) handleMotion(motion);
    maybeAnalyseFrame();
    drawOverlay();
  }

  function computeMotion(canvas) {
    // Downscale to 32x24 grayscale, compare with the previous frame.
    var small = document.createElement("canvas");
    small.width = 32; small.height = 24;
    var sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, 32, 24);
    var data;
    try { data = sctx.getImageData(0, 0, 32, 24).data; }
    catch (e) { return { ratio: 0, box: null }; }
    var gray = [];
    for (var i = 0; i < data.length; i += 4) {
      gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
    }
    var result = { ratio: 0, box: null };
    if (prevGray) {
      var changed = 0, minX = 32, minY = 24, maxX = -1, maxY = -1;
      for (var p = 0; p < gray.length; p++) {
        if (Math.abs(gray[p] - prevGray[p]) > settings.motionSensitivity) {
          changed++;
          var x = p % 32, y = Math.floor(p / 32);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      result.ratio = changed / gray.length;
      if (maxX >= 0) {
        result.box = { x: minX / 32, y: minY / 24, w: (maxX - minX + 1) / 32, h: (maxY - minY + 1) / 24 };
      }
    }
    prevGray = gray;
    return result;
  }

  function handleMotion(motion) {
    var now = Date.now();
    els.motionStatus.textContent = "Motion: " + Math.round(motion.ratio * 100) + "% changed.";
    if (settings.zonesEnabled && motion.box) {
      var zone = L.detectionInAnyZone(motion.box, zones);
      if (zone) {
        var key = "zone:" + zone.id;
        if (L.shouldNotify(lastNotified[key], now, settings.cooldownMinutes)) {
          lastNotified[key] = now;
          saveJson(KEYS.lastNotified, lastNotified);
          var msg = "Movement in " + (zone.name || "a watch zone") + ".";
          addFeed("alert", msg);
          speak("Movement in " + (zone.name || "the watch zone") + ".");
          showKnownChip("Movement in a watch zone — alert raised.");
          // In local-only mode (no validated detection model), offer to
          // label whoever is in the live frame.
          if (!hfDetectionReady()) offerLabelFromFrame(motion.box, "movement in a watch zone");
        } else {
          addFeed("motion", "Movement in " + (zone.name || "a watch zone") + " again — you already know, no repeat alert.");
          showKnownChip("You already know there's movement in the watch zone.");
        }
        return;
      }
    }
    // Outside zones: log only, throttled.
    if (now - prevMotionAt > 10000) {
      prevMotionAt = now;
      addFeed("motion", "Movement outside any watch zone — logged only.");
    }
  }

  /* ---------------- Hugging Face analysis ---------------- */
  function maybeAnalyseFrame() {
    // Only when the detection model validated as actually deployed.
    // A saved token alone never enables calls; validation runs on
    // save and on app open, and a running watch picks the result up
    // here on the very next live sample.
    if (!hfDetectionReady()) return; // local-only mode: no frames leave the device
    if (hfBusy) return;
    if (Date.now() - lastHfAt < HF_MIN_INTERVAL_MS) return;
    // The blob below is built from the in-memory canvas only, sent once,
    // and then dropped. No frame is stored anywhere.
    var blob = null;
    try {
      blob = dataURLToBlob(frameCanvas.toDataURL("image/jpeg", 0.8));
    } catch (e) { return; }
    if (!blob) return;
    hfBusy = true;
    lastHfAt = Date.now();
    analyseWithHf(blob).finally(function () { hfBusy = false; });
  }

  function dataURLToBlob(dataUrl) {
    var parts = dataUrl.split(",");
    if (parts.length !== 2) return null;
    var bin = atob(parts[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/jpeg" });
  }

  function hfPost(modelId, blob) {
    return fetch("https://api-inference.huggingface.co/models/" + modelId, {
      method: "POST",
      headers: { Authorization: "Bearer " + settings.hfToken },
      body: blob
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Hugging Face rejected the token (HTTP " + res.status + "). Check the token in Settings.");
      }
      if (res.status === 503) {
        throw new Error("Model is still loading on Hugging Face. It usually works on a later try.");
      }
      if (!res.ok) throw new Error("Hugging Face returned HTTP " + res.status + ".");
      return res.json();
    });
  }

  function analyseWithHf(blob) {
    return hfPost(settings.detectModel, blob).then(function (detections) {
      var list = Array.isArray(detections) ? detections : [];
      lastDetections = list
        .filter(function (d) { return d && d.score >= 0.5 && d.box; })
        .map(function (d) {
          // DETR-style boxes are 0..1000; other detectors may use 0..1.
          var scale = (d.box.xmax > 1.5 || d.box.ymax > 1.5) ? 1000 : 1;
          return {
            label: String(d.label || "").toLowerCase(),
            score: d.score,
            box: {
              x: d.box.xmin / scale, y: d.box.ymin / scale,
              w: (d.box.xmax - d.box.xmin) / scale, h: (d.box.ymax - d.box.ymin) / scale
            }
          };
        });
      lastDetections.forEach(function (d) { d.expires = Date.now() + 3000; });
      handleDetections(lastDetections);
      if (!lastDetections.length) return;
      // Descriptions only when a description model validated as
      // deployed. Otherwise plain detection-based wording — never a
      // claim that a description model answered when it did not.
      if (!hfCaptionsReady()) {
        var summary = lastDetections.map(function (d) {
          return d.label + " (" + Math.round(d.score * 100) + "%)";
        }).join(", ");
        var wording = "Sees: " + summary;
        els.lastDescription.textContent = wording;
        addFeed("sighting", "Camera sees: " + summary + " (finding only — no describing).");
        return;
      }
      // One caption per analysed frame that had something in it.
      return hfPost(settings.captionModel, blob).then(function (cap) {
        var text = Array.isArray(cap) && cap[0] ? cap[0].generated_text : "";
        if (text) {
          els.lastDescription.textContent = text;
          addFeed("sighting", "Camera sees: " + text);
        }
      }).catch(function () { /* caption failure must not break detection handling */ });
    }).catch(function (err) {
      els.lastDescription.textContent = "Could not check: " + err.message;
      addFeed("system", "Check failed: " + err.message);
    });
  }

  /* ---------------- live-frame crops & signatures ----------------
   * The crop below is cut from the CURRENT live frame held in the
   * in-memory canvas. The signature (numbers only) is what gets kept.
   * previewDataUrl is a TRANSIENT on-screen preview for the naming
   * card only: it lives in memory, is shown while the user names the
   * person, and is never assigned to a stored record. Stored records
   * pass through L.stripImageData() before saving, which drops any
   * image field as a second guard. */
  function cropSignature(box) {
    // Returns {signature, previewDataUrl} or null. Crop from the 320x240 frame.
    var sx = Math.max(0, Math.floor(box.x * 320));
    var sy = Math.max(0, Math.floor(box.y * 240));
    var sw = Math.max(8, Math.floor(box.w * 320));
    var sh = Math.max(8, Math.floor(box.h * 240));
    if (sx + sw > 320) sw = 320 - sx;
    if (sy + sh > 240) sh = 240 - sy;
    var crop = document.createElement("canvas");
    crop.width = 96; crop.height = 96;
    var cctx = crop.getContext("2d");
    try { cctx.drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, 96, 96); }
    catch (e) { return null; }
    var tiny = document.createElement("canvas");
    tiny.width = 8; tiny.height = 8;
    var tctx = tiny.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(crop, 0, 0, 8, 8);
    var data;
    try { data = tctx.getImageData(0, 0, 8, 8).data; }
    catch (e) { return null; }
    var gray = [];
    for (var i = 0; i < data.length; i += 4) gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
    var signature = L.makeSignature(gray);
    if (!signature) return null;
    return { signature: signature, previewDataUrl: crop.toDataURL("image/jpeg", 0.7) };
  }

  function signatureAlreadyPending(signature) {
    return pendingSignatures.some(function (s) { return L.signaturesMatch(signature, s); });
  }

  /* Enrollment photos are TRANSIENT ONLY (people and cars): one frame
   * is shown while the user is asked about someone/something new, and
   * the picture is deleted straight away once the user answers or
   * cancels. The photo lives only in the crop object below and in the
   * on-screen <img> while the prompt is open; it is never assigned to
   * a stored record and never enters the event-snapshot gallery.
   * pendingEnrollmentCrop tracks the one live preview so it can be
   * discarded the moment a prompt resolves. */
  var pendingEnrollmentCrop = null;
  function discardEnrollmentPhoto(crop) {
    if (crop) crop.previewDataUrl = null; // drop the only JS reference to the picture
    if (pendingEnrollmentCrop === crop) pendingEnrollmentCrop = null;
  }

  /* ---------------- detections ---------------- */
  function handleDetections(detections) {
    var now = Date.now();
    detections.forEach(function (d) {
      var zone = settings.zonesEnabled ? L.detectionInAnyZone(d.box, zones) : null;
      if (d.label === "person") {
        handlePerson(d, zone, now);
      } else if (CAR_LABELS[d.label]) {
        handleCar(d, zone, now);
      } else if (zone) {
        addFeed("sighting", "Something (" + d.label + ") in " + (zone.name || "a watch zone") + " — logged only.");
      }
    });
  }

  function handlePerson(detection, zone, now) {
    var crop = cropSignature(detection.box);
    if (!crop) { addFeed("sighting", "A person is on camera (live frame could not be read)."); return; }
    var match = L.findBestMatch(crop.signature, people);
    if (match) {
      recordPersonSighting(match, now, detection, zone);
      return;
    }
    // Unknown person: ask who they are — once per signature, not every frame.
    // NOTE: this alert happens for EVERY unknown person, in or out of a
    // zone. Only the saved photograph is limited to zone/suspicious
    // events (see below); notifications are never limited that way.
    if (signatureAlreadyPending(crop.signature)) {
      noteLingering(crop.signature, now, zone);
      return;
    }
    pendingSignatures.push(crop.signature);
    if (pendingSignatures.length > 5) pendingSignatures.shift();
    var where = zone ? " in " + (zone.name || "a watch zone") : "";
    addFeed("sighting", "An unknown person is on camera" + where + ". Asking who they are.");
    showIdentifyCard(crop, zone);
    speak("Who is this?");
    if (zone) {
      showAlertSnapshot(
        captureEventSnapshot("zone", "An unknown person was seen in " + (zone.name || "a watch zone") + ".", "Unknown person in a watch zone"),
        "Unknown person in a watch zone");
    }
    noteLingering(crop.signature, now, zone);
  }

  /* Unknown person still there across several live samples: "lingering"
   * is suspicious activity, so one event snapshot is captured for it —
   * once per signature. The spoken/on-screen "who is this?" alert above
   * already fired on first sighting; lingering only adds the photo. */
  var lingerTrack = {}; // signature hash -> {firstAt, samples, captured}
  function noteLingering(signature, now, zone) {
    var key = signature.hash;
    var track = lingerTrack[key];
    if (!track) {
      track = { firstAt: now, samples: 0, captured: false };
      lingerTrack[key] = track;
    }
    track.samples++;
    var keys = Object.keys(lingerTrack);
    if (keys.length > 20) delete lingerTrack[keys[0]];
    if (!track.captured && track.samples >= 3 && now - track.firstAt >= 20000) {
      track.captured = true;
      addFeed("alert", "An unknown person has been on the live feed for " +
        Math.round((now - track.firstAt) / 1000) + " seconds. Picture saved on this phone only.");
      speak("An unknown person has been lingering on camera.");
      showAlertSnapshot(
        captureEventSnapshot("lingering", "An unknown person lingered on the live feed.", "Unknown person lingering"),
        "Unknown person lingering");
    }
  }

  function recordPersonSighting(person, now, detection, zone) {
    person.sightings = person.sightings || [];
    person.sightings.push(now);
    if (person.sightings.length > 500) person.sightings = person.sightings.slice(-500);
    person.lastSeen = now;
    if (!person.confirmed) {
      showSuggestionCard(person, detection);
      if (zone) {
        showAlertSnapshot(
          captureEventSnapshot("zone", person.name + " was seen in " + (zone.name || "a watch zone") + ".", "Person in a watch zone"),
          "Person in a watch zone");
      }
      savePeople();
      renderPeople();
      return;
    }
    savePeople();
    renderPeople();
    var where = zone ? " in " + (zone.name || "a watch zone") : "";
    if (L.shouldNotify(lastNotified["person:" + person.id], now, settings.cooldownMinutes)) {
      lastNotified["person:" + person.id] = now;
      saveJson(KEYS.lastNotified, lastNotified);
      addFeed("alert", person.name + " is on camera" + where + ".");
      speak(person.name + " is on camera.");
      showKnownChip(person.name + " is on camera.");
      if (zone) {
        showAlertSnapshot(
          captureEventSnapshot("zone", person.name + " entered " + (zone.name || "a watch zone") + ".", "Person in a watch zone"),
          "Person in a watch zone");
      }
    } else {
      addFeed("sighting", person.name + " is still on camera" + where + " — you already know they're there, no repeat alert.");
      showKnownChip("You already know " + person.name + " is there — no repeat alert.");
    }
  }

  function handleCar(detection, zone, now) {
    var crop = cropSignature(detection.box);
    if (!crop) return;
    var match = L.findBestMatch(crop.signature, cars);
    var car = match;
    var isNewCar = !match;
    if (!car) {
      car = {
        id: uid(), signatures: [crop.signature],
        sightings: [], firstSeen: now, lastSeen: now,
        livesNearby: null, lastAskedAt: 0, lastPassAt: 0,
        enrollmentAskedAt: 0 // first-sighting "does it live here?" prompt
      };
      cars.push(car);
    }
    // One pass per gap: many frames of the same drive-by count once.
    if (L.shouldCountNewPass(car.lastPassAt, now)) {
      car.sightings.push(now);
      if (car.sightings.length > 500) car.sightings = car.sightings.slice(-500);
    }
    car.lastPassAt = now;
    car.lastSeen = now;
    saveCars();
    renderCars();
    // Getting to know a new car: one transient picture, one question,
    // then the picture is deleted straight away (see offerCarEnrollment).
    if (isNewCar) offerCarEnrollment(car, crop);
    var weekCount = L.countInWindow(car.sightings, now);
    if (L.isRepeatSuspicious(weekCount, settings.repeatThreshold) &&
        car.livesNearby !== true &&
        now - (car.lastAskedAt || 0) > L.SEVEN_DAYS_MS) {
      car.lastAskedAt = now;
      saveCars();
      // Suspicious activity: one event snapshot, shown with the question.
      var snap = captureEventSnapshot("suspicious-car",
        "This car has passed " + weekCount + " times in the last 7 days.",
        "Repeat car — event snapshot");
      showCarQuestion(car, weekCount, snap);
    } else if (zone) {
      addFeed("sighting", "A car passed through " + (zone.name || "a watch zone") + " — logged.");
    }
  }

  /* ---------------- identify / suggestion / car question cards ---------------- */
  function showKnownChip(text) {
    els.knownChip.innerHTML = "<span class='chip'>" + esc(text) + "</span>";
  }

  function showIdentifyCard(crop, zone) {
    var where = zone ? " in " + (zone.name || "a watch zone") : "";
    /* The preview below is a TRANSIENT enrollment snapshot: it shows
     * one live frame while the user names the person, and the picture
     * is deleted straight away once the user saves or cancels — it is
     * never saved and never enters the event-snapshot gallery. Only
     * the numeric signature, the name, and timestamps are stored. */
    if (pendingEnrollmentCrop && pendingEnrollmentCrop !== crop) discardEnrollmentPhoto(pendingEnrollmentCrop);
    pendingEnrollmentCrop = crop;
    var preview = crop.previewDataUrl
      ? "<img src='" + esc(crop.previewDataUrl) + "' alt='Unknown person on the live feed'>"
      : "";
    els.identifyArea.innerHTML =
      "<div class='card warnbox'><h2>Who is this?</h2>" +
      "<p>An unknown person is on the live feed" + esc(where) + ". The app will " +
      "remember the name <b>you</b> give, for this camera only. " +
      "This picture shows only while you answer. It is deleted right away. " +
      "Only numbers are kept.</p>" +
      "<div class='row'>" + preview +
      "<div><label for='identifyName'>Name</label>" +
      "<input type='text' id='identifyName' placeholder='Type their name' autocomplete='off'>" +
      "<div class='row' style='margin-top:8px'>" +
      "<button type='button' id='identifySave' class='primary'>Remember this person</button>" +
      "<button type='button' id='identifyDismiss'>Ignore</button>" +
      "</div></div></div></div>";
    $("identifySave").addEventListener("click", function () {
      var name = $("identifyName").value.trim();
      if (!name) { $("identifyName").focus(); return; }
      var person = {
        id: uid(), name: name, signatures: [crop.signature],
        sightings: [Date.now()], firstSeen: Date.now(), lastSeen: Date.now(), confirmed: true
      };
      people.push(person);
      savePeople(); // stripImageData: only the signature, name and timestamps reach storage
      renderPeople();
      // Enrollment photo deleted straight away: drop the picture data and
      // remove the prompt from the screen. It was never stored.
      discardEnrollmentPhoto(crop);
      els.identifyArea.innerHTML = "";
      addFeed("memory", "Remembered \"" + name + "\" from this camera (numbers only — the picture was deleted right away).");
      speak("Remembered " + name + ".", "info");
    });
    $("identifyDismiss").addEventListener("click", function () {
      // Cancelled: the enrollment photo is deleted straight away too.
      discardEnrollmentPhoto(crop);
      els.identifyArea.innerHTML = "";
      addFeed("memory", "Unknown person ignored. Not remembered. The picture was deleted right away.");
    });
    var input = $("identifyName");
    if (input) input.focus();
  }

  function offerLabelFromFrame(box, reason) {
    // Local-only mode: let the user label whoever is in the live frame.
    // Nothing is saved from the frame itself — only the number signature.
    if (els.identifyArea.innerHTML) return;
    var crop = cropSignature(box);
    if (!crop) return;
    if (signatureAlreadyPending(crop.signature)) return;
    pendingSignatures.push(crop.signature);
    showIdentifyCard(crop, null);
    addFeed("sighting", "Someone is on camera. Name them if you know them. No picture is saved.");
  }

  function showSuggestionCard(person, detection) {
    if (els.identifyArea.innerHTML) return;
    var crop = cropSignature(detection.box);
    /* Transient enrollment-style preview: shown only while the user
     * answers, deleted straight away on confirm. On "No" the same crop
     * is handed to the naming card, which deletes it when that prompt
     * resolves. */
    if (crop) {
      if (pendingEnrollmentCrop && pendingEnrollmentCrop !== crop) discardEnrollmentPhoto(pendingEnrollmentCrop);
      pendingEnrollmentCrop = crop;
    }
    var preview = crop && crop.previewDataUrl
      ? "<img src='" + esc(crop.previewDataUrl) + "' alt='Possible sighting on the live feed'>"
      : "";
    els.identifyArea.innerHTML =
      "<div class='card'><h2>Is this " + esc(person.name) + "?</h2>" +
      "<p>The app thinks this looks like " + esc(person.name) + ". Matching is rough. " +
      "It can be wrong. This picture is deleted as soon as you answer. It is never saved.</p>" +
      "<div class='row'>" + preview +
      "<div class='row'><button type='button' id='suggestYes' class='primary'>Yes, that's " + esc(person.name) + "</button>" +
      "<button type='button' id='suggestNo'>No, someone else</button></div></div></div>";
    $("suggestYes").addEventListener("click", function () {
      person.confirmed = true;
      discardEnrollmentPhoto(crop);
      recordPersonSighting(person, Date.now(), detection, null);
      els.identifyArea.innerHTML = "";
    });
    $("suggestNo").addEventListener("click", function () {
      els.identifyArea.innerHTML = "";
      if (crop && crop.signature) showIdentifyCard(crop, null);
    });
  }

  function showCarQuestion(car, weekCount, snap) {
    /* The event snapshot (if one was captured for this flag) is shown
     * with the question. It is the stored event still — it deletes
     * itself after the retention window unless saved. */
    var snapHtml = snap
      ? "<div class='row'><img src='" + esc(snap.dataUrl || "") + "' alt='Event still of the repeat car' style='width:110px;height:110px;object-fit:cover;border-radius:10px'>" +
        "<div class='muted'>" + esc(snapshotLeftText(snap, Date.now())) + "</div></div>"
      : "";
    els.carQuestionArea.innerHTML =
      "<div class='card warnbox'><h2>Car seen " + weekCount + " times this week</h2>" +
      snapHtml +
      "<div><p>This car has passed " + weekCount + " times in the last 7 days. " +
      "Does this car live around here?</p>" +
      "<div class='row'><button type='button' id='carLivesYes' class='primary'>Yes, it lives here</button>" +
      "<button type='button' id='carLivesNo'>No</button></div></div></div>";
    addFeed("alert", "A car has passed " + weekCount + " times in 7 days. Asked if it lives near here.");
    speak("A car has passed " + weekCount + " times this week. Does it live around here?");
    $("carLivesYes").addEventListener("click", function () {
      car.livesNearby = true;
      saveCars();
      renderCars();
      addFeed("memory", "Marked: this car lives around here. No more repeat questions about it.");
      els.carQuestionArea.innerHTML = "";
    });
    $("carLivesNo").addEventListener("click", function () {
      car.livesNearby = false;
      saveCars();
      renderCars();
      addFeed("memory", "Marked: this car does not live around here. It will be asked about again at most once a week.");
      els.carQuestionArea.innerHTML = "";
    });
  }

  /* ---------------- car enrollment: transient photo, then deleted ----------------
   * When a car is seen for the FIRST time: show ONE frame from the live
   * feed next to the question "Does this car live around here?", save
   * ONLY the answer plus the numeric signature and timestamps, then
   * DELETE the photo straight away — on answering AND on dismissing.
   * The enrollment photo is never written to storage and never enters
   * the event-snapshot gallery (that gallery is only zone/suspicious
   * stills, kept up to 6 hours unless saved). This is the same rule as
   * meeting a new person: show one picture to ask, save the answer,
   * delete the picture. */
  function offerCarEnrollment(car, crop) {
    if (!crop || !crop.previewDataUrl) return;
    if (car.enrollmentAskedAt) return; // asked once per car; never nag
    if (els.carQuestionArea.innerHTML) return; // a question is already showing
    if (pendingEnrollmentCrop && pendingEnrollmentCrop !== crop) discardEnrollmentPhoto(pendingEnrollmentCrop);
    pendingEnrollmentCrop = crop;
    car.enrollmentAskedAt = Date.now();
    saveCars(); // stripImageData: signature + answer + timestamps only, no picture
    els.carQuestionArea.innerHTML =
      "<div class='card warnbox'><h2>New car on camera</h2>" +
      "<div class='row'><img src='" + esc(crop.previewDataUrl) + "' alt='New car on the live feed' style='width:110px;height:110px;object-fit:cover;border-radius:10px'>" +
      "<div><p>This car has not been seen before. Does this car live around here?</p>" +
      "<p class='muted'>This picture shows only while you answer. It is deleted " +
      "right away. It is never saved. Only your answer and numbers are kept.</p>" +
      "<div class='row'><button type='button' id='carEnrollYes' class='primary'>Yes, it lives here</button>" +
      "<button type='button' id='carEnrollNo'>No</button>" +
      "<button type='button' id='carEnrollLater'>Not sure yet</button></div></div></div></div>";
    speak("A new car is on camera. Does it live around here?");
    addFeed("sighting", "A new car was seen for the first time. Asked whether it lives around here.");
    function resolveEnroll(answer, feedText) {
      // The enrollment photo is deleted straight away, whatever the answer.
      discardEnrollmentPhoto(crop);
      els.carQuestionArea.innerHTML = "";
      if (answer !== null) car.livesNearby = answer;
      saveCars();
      renderCars();
      addFeed("memory", feedText);
    }
    $("carEnrollYes").addEventListener("click", function () {
      resolveEnroll(true, "Marked: this car lives near here.");
    });
    $("carEnrollNo").addEventListener("click", function () {
      resolveEnroll(false, "Marked: this car does not live near here.");
    });
    $("carEnrollLater").addEventListener("click", function () {
      resolveEnroll(null, "New car left unanswered. The picture was deleted right away.");
    });
  }

  /* ---------------- overlay & zones ---------------- */
  function fitOverlay() {
    var rect = els.previewWrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    els.overlayCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    els.overlayCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    drawOverlay();
  }

  function clearOverlay() {
    var ctx = els.overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
  }

  function drawOverlay() {
    var canvas = els.overlayCanvas;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Zones
    zones.forEach(function (z, i) {
      ctx.strokeStyle = "#ffb020";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(z.x * W, z.y * H, z.w * W, z.h * H);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffb020";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText(z.name || ("Zone " + (i + 1)), z.x * W + 6, z.y * H + 18);
    });
    if (drawingRect) {
      ctx.strokeStyle = "#4da3ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(drawingRect.x * W, drawingRect.y * H, drawingRect.w * W, drawingRect.h * H);
    }
    // Recent detections
    var now = Date.now();
    lastDetections = lastDetections.filter(function (d) { return d.expires > now; });
    lastDetections.forEach(function (d) {
      ctx.strokeStyle = d.label === "person" ? "#3ecf8e" : "#4da3ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(d.box.x * W, d.box.y * H, d.box.w * W, d.box.h * H);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText(d.label + " " + Math.round(d.score * 100) + "%", d.box.x * W + 4, d.box.y * H + 16);
    });
  }

  function overlayPoint(ev) {
    var rect = els.overlayCanvas.getBoundingClientRect();
    var clientX = ev.clientX, clientY = ev.clientY;
    if (ev.touches && ev.touches[0]) { clientX = ev.touches[0].clientX; clientY = ev.touches[0].clientY; }
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  }

  var drawStart = null;
  function bindZoneDrawing() {
    var canvas = els.overlayCanvas;
    function start(ev) {
      if (!drawMode) return;
      ev.preventDefault();
      drawStart = overlayPoint(ev);
      drawingRect = { x: drawStart.x, y: drawStart.y, w: 0, h: 0 };
    }
    function move(ev) {
      if (!drawMode || !drawStart) return;
      ev.preventDefault();
      var p = overlayPoint(ev);
      drawingRect = {
        x: Math.min(drawStart.x, p.x), y: Math.min(drawStart.y, p.y),
        w: Math.abs(p.x - drawStart.x), h: Math.abs(p.y - drawStart.y)
      };
      drawOverlay();
    }
    function end(ev) {
      if (!drawMode || !drawStart) return;
      ev.preventDefault();
      if (drawingRect && drawingRect.w > 0.02 && drawingRect.h > 0.02) {
        var zone = {
          id: uid(), name: "Zone " + (zones.length + 1),
          x: drawingRect.x, y: drawingRect.y, w: drawingRect.w, h: drawingRect.h
        };
        zones.push(zone);
        saveJson(KEYS.zones, zones);
        renderZones();
        addFeed("system", (zone.name) + " created. Movement and people inside it will raise alerts.");
      }
      drawStart = null;
      drawingRect = null;
      drawMode = false;
      els.drawZoneBtn.textContent = "Draw a watch zone";
      drawOverlay();
    }
    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /* ---------------- "Get running" three-step setup card ----------------
   *
   * 1. Connect a camera — done when a source is ready to start: the
   *    phone camera selected, or Wi-Fi selected with a stream URL typed
   *    in. 2. Type in the token — done when the saved token validated
   *    and the detection model is live. 3. Start it — done while a
   *    camera is watching. Each step's button jumps to the control it
   *    describes (step 3 starts watching with the chosen source).
   *
   * The card starts expanded. On the first watch start with all three
   * steps done it folds itself away; the user can always reopen it,
   * and a manual expand is respected for the rest of the session. A
   * manual collapse/expand choice is remembered in this browser. */
  var setupCollapsed = loadJson(KEYS.setupCollapsed, false) === true;
  var setupManuallyExpanded = false;
  var setupAutoCollapsed = false;

  function setupStepDone(step) {
    if (step === 1) {
      if (els.sourceSelect.value === "wifi") return Boolean(els.streamUrl.value.trim());
      return true; // this phone's camera needs no configuration
    }
    if (step === 2) return hfDetectionReady();
    return activeSource !== null; // step 3: watching right now
  }

  function renderSetupCard() {
    if (!els.setupCard) return;
    var steps = [
      { li: els.setupStep1, check: els.setupStep1.querySelector(".setup-check"), note: els.setupStep1Note,
        done: setupStepDone(1),
        doneNote: "Ready.",
        todoNote: els.sourceSelect.value === "wifi"
          ? "Pick Wi-Fi camera. Type its web address."
          : "Phone camera picked. Nothing to type." },
      { li: els.setupStep2, check: els.setupStep2.querySelector(".setup-check"), note: els.setupStep2Note,
        done: setupStepDone(2),
        doneNote: "Connected. Finding is on.",
        todoNote: !settings.hfToken
          ? "No token. The app works, but no AI names."
          : hfStatus.token === "checking" ? "Checking token…"
          : hfStatus.token === "invalid" ? "That token did not work. Check Settings."
          : hfStatus.token === "error" ? "Could not reach Hugging Face. Save again to retry."
          : hfStatus.token === "valid" ? "Token is good. The finding model is not running."
          : "Models connect by themselves once the token checks out." },
      { li: els.setupStep3, check: els.setupStep3.querySelector(".setup-check"), note: els.setupStep3Note,
        done: setupStepDone(3),
        doneNote: "Watching now.",
        todoNote: "Tap Start below, or on this step." }
    ];
    steps.forEach(function (s, i) {
      if (!s.li) return;
      s.li.classList.toggle("done", s.done);
      if (s.check) s.check.textContent = s.done ? "✓" : String(i + 1);
      if (s.note) s.note.textContent = s.done ? s.doneNote : s.todoNote;
    });
    els.setupCard.classList.toggle("collapsed", setupCollapsed);
    els.setupToggleBtn.textContent = setupCollapsed ? "Show" : "Hide";
    els.setupToggleBtn.setAttribute("aria-expanded", setupCollapsed ? "false" : "true");
  }

  function flashControl(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    el.classList.remove("flash-target");
    void el.offsetWidth; // restart the highlight animation
    el.classList.add("flash-target");
    setTimeout(function () { el.classList.remove("flash-target"); }, 1700);
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }

  function maybeAutoCollapseSetupCard() {
    if (setupAutoCollapsed || setupManuallyExpanded) return;
    if (setupStepDone(1) && setupStepDone(2) && setupStepDone(3)) {
      setupCollapsed = true;
      setupAutoCollapsed = true;
      saveJson(KEYS.setupCollapsed, true);
    }
    renderSetupCard();
  }

  /* ---------------- navigation & settings ---------------- */
  var sweepTimer = null;
  // Sliding active pill in the tab rail: a single amber element glides
  // behind the active tab (transform + width transition in CSS). First
  // placement is instant (no-anim) so it never visibly sweeps in on load.
  // No-op if the indicator element is missing; tab switching is unaffected.
  var navIndicatorEl = null, navIndicatorInit = false;
  function positionNavIndicator() {
    var navEl = document.querySelector("nav");
    var activeBtn = navEl ? navEl.querySelector("button.active") : null;
    if (!navEl || !activeBtn) return;
    if (!navIndicatorEl) navIndicatorEl = document.getElementById("navIndicator");
    if (!navIndicatorEl) return;
    if (!navIndicatorInit) {
      navEl.classList.add("no-anim");
      navIndicatorEl.style.width = activeBtn.offsetWidth + "px";
      navIndicatorEl.style.transform = "translateX(" + activeBtn.offsetLeft + "px)";
      void navIndicatorEl.offsetWidth; // commit the instant placement
      navEl.classList.remove("no-anim");
      navIndicatorInit = true;
    } else {
      navIndicatorEl.style.width = activeBtn.offsetWidth + "px";
      navIndicatorEl.style.transform = "translateX(" + activeBtn.offsetLeft + "px)";
    }
  }
  function showSection(name) {
    var currentBtn = document.querySelector("nav button.active");
    var switching = !currentBtn || currentBtn.getAttribute("data-section") !== name;
    document.querySelectorAll("nav button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-section") === name);
    });
    positionNavIndicator();
    document.querySelectorAll("main > section").forEach(function (s) {
      s.classList.toggle("active", s.id === "section-" + name);
    });
    // Gadget transition: instant switch, decorative amber sweep on top.
    // Skipped when re-selecting the current tab or when the user prefers
    // reduced motion (the CSS rule also kills the animation in that case).
    // Keyboard activation fires the same click handler, so it gets the
    // same treatment. Never blocks input: the sweep overlay is
    // pointer-events:none and the class is removed after ~300ms.
    if (switching) {
      var mainEl = document.querySelector("main");
      var reduced = false;
      try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
      if (mainEl && !reduced) {
        mainEl.classList.remove("sweeping");
        void mainEl.offsetWidth; // restart the sweep animation
        mainEl.classList.add("sweeping");
        if (sweepTimer) clearTimeout(sweepTimer);
        sweepTimer = setTimeout(function () { mainEl.classList.remove("sweeping"); }, 300);
      }
    }
    if (name === "watch") fitOverlay();
  }

  function fillSettingsForm() {
    els.setHfToken.value = settings.hfToken || "";
    els.setDetectModel.value = settings.detectModel;
    els.setCaptionModel.value = settings.captionModel;
    els.setCooldown.value = settings.cooldownMinutes;
    els.setThreshold.value = settings.repeatThreshold;
    els.setSensitivity.value = settings.motionSensitivity;
    els.setSampleFps.value = settings.sampleFps;
    els.setRetentionHours.value = settings.snapshotRetentionHours;
    els.zonesEnabled.checked = settings.zonesEnabled;
    els.voiceEnabled.checked = settings.voiceEnabled;
    els.speakAlerts.checked = settings.speakAlerts;
    els.speakMode.value = settings.speakMode;
    els.speechRate.value = settings.speechRate;
    populateVoiceList();
    if (els.speechVoice && settings.speechVoice) els.speechVoice.value = settings.speechVoice;
  }

  function bindEvents() {
    document.querySelectorAll("nav button").forEach(function (b) {
      b.addEventListener("click", function () { showSection(b.getAttribute("data-section")); });
    });
    window.addEventListener("resize", positionNavIndicator);
    els.sourceSelect.addEventListener("change", function () {
      var isWifi = els.sourceSelect.value === "wifi";
      els.wifiFields.hidden = !isWifi;
      els.startPhoneBtn.hidden = isWifi;
      els.connectStreamBtn.hidden = !isWifi;
      renderSetupCard(); // step 1 readiness depends on the chosen source
    });
    els.streamUrl.addEventListener("input", renderSetupCard);
    // "Get running" card: collapse toggle + per-step jump buttons.
    els.setupToggleBtn.addEventListener("click", function () {
      setupCollapsed = !setupCollapsed;
      if (!setupCollapsed) setupManuallyExpanded = true;
      saveJson(KEYS.setupCollapsed, setupCollapsed);
      renderSetupCard();
    });
    els.setupStep1Btn.addEventListener("click", function () { flashControl(els.sourceSelect); });
    els.setupStep2Btn.addEventListener("click", function () {
      showSection("settings");
      flashControl(els.setHfToken);
    });
    els.setupStep3Btn.addEventListener("click", function () {
      showSection("watch");
      if (els.sourceSelect.value === "wifi") connectStream();
      else startPhoneCamera();
    });
    els.startPhoneBtn.addEventListener("click", startPhoneCamera);
    els.connectStreamBtn.addEventListener("click", connectStream);
    els.stopCameraBtn.addEventListener("click", function () {
      stopCamera();
      addFeed("system", "Camera stopped.");
    });
    els.drawZoneBtn.addEventListener("click", function () {
      drawMode = !drawMode;
      els.drawZoneBtn.textContent = drawMode ? "Drawing… drag on the picture" : "Draw a zone";
      if (drawMode) els.cameraStatus.textContent = "Draw a box on the live picture.";
    });
    els.clearZonesBtn.addEventListener("click", function () {
      zones = [];
      saveJson(KEYS.zones, zones);
      renderZones();
      drawOverlay();
      addFeed("system", "All watch zones cleared.");
    });
    els.labelNowBtn.addEventListener("click", function () {
      var el = currentSourceElement();
      if (!el || !activeSource) { els.cameraStatus.textContent = "Start a camera first."; return; }
      sampleFrame();
      offerLabelFromFrame({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 }, "the live feed (manual check)");
    });
    els.notifyPermBtn.addEventListener("click", function () {
      if (!("Notification" in window)) {
        els.notifyStatus.textContent = "Notifications are not supported in this browser.";
        return;
      }
      Notification.requestPermission().then(function () { updateNotifyStatus(); });
    });
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.addEventListener("voiceschanged", populateVoiceList); } catch (e) {}
    }
    document.addEventListener("visibilitychange", function () {
      // Wake locks are released by the browser when the page hides;
      // re-request when the watch page comes back into view.
      if (!document.hidden && activeSource) requestWakeLock();
    });
    els.micBtn.addEventListener("click", startListening);
    els.stopVoiceBtn.addEventListener("click", function () {
      if (recognition) { try { recognition.stop(); } catch (e) {} }
      stopSpeaking();
      els.voiceStatus.textContent = "Stopped listening.";
    });
    els.clearFeedBtn.addEventListener("click", function () {
      feed = [];
      saveJson(KEYS.feed, feed);
      renderFeed();
    });
    els.saveSettingsBtn.addEventListener("click", function () {
      settings.hfToken = els.setHfToken.value.trim();
      settings.detectModel = els.setDetectModel.value.trim() || DEFAULT_SETTINGS.detectModel;
      settings.captionModel = els.setCaptionModel.value.trim() || DEFAULT_SETTINGS.captionModel;
      settings.cooldownMinutes = Math.max(0, Math.min(1440, parseInt(els.setCooldown.value, 10) || 0));
      settings.repeatThreshold = Math.max(1, Math.min(50, parseInt(els.setThreshold.value, 10) || 3));
      settings.motionSensitivity = Math.max(5, Math.min(80, parseInt(els.setSensitivity.value, 10) || 25));
      settings.sampleFps = Math.max(0.25, Math.min(4, parseFloat(els.setSampleFps.value) || 1));
      settings.snapshotRetentionHours = Math.max(1, Math.min(168, parseFloat(els.setRetentionHours.value) || 6));
      settings.zonesEnabled = els.zonesEnabled.checked;
      settings.voiceEnabled = els.voiceEnabled.checked;
      settings.speakAlerts = els.speakAlerts.checked;
      settings.speakMode = els.speakMode.value === "all" ? "all" : "alerts";
      settings.speechVoice = els.speechVoice.value || "";
      settings.speechRate = Math.max(0.5, Math.min(2, parseFloat(els.speechRate.value) || 1));
      saveJson(KEYS.settings, settings);
      updateVoiceStatus();
      sweepSnapshots(true); // a shorter retention deletes expired snapshots at once
      renderSnapshots();
      if (activeSource) startSampling(); // new live-feed sample rate takes effect at once
      addFeed("system", "Settings saved.");
      // AUTO-CONNECT: saving a token validates it at once and the
      // models start working on the next live sample — no extra step.
      // A running watch picks the result up by itself.
      els.settingsStatus.textContent = "Saved. Checking token…";
      validateHfConnection({ announce: true });
    });
    els.clearTokenBtn.addEventListener("click", function () {
      settings.hfToken = "";
      els.setHfToken.value = "";
      hfStatus = { token: "none", detection: "unknown", captions: "off", checkedAt: Date.now() };
      saveHfStatus();
      saveJson(KEYS.settings, settings);
      renderModeBadge();
      renderHfSettingsStatus("Token removed.");
      renderSetupCard();
    });
    els.clearAllBtn.addEventListener("click", function () {
      if (!window.confirm("Erase all Tweaker Camera data in this browser (settings, people, cars, zones, log)?")) return;
      Object.keys(KEYS).forEach(function (k) { try { localStorage.removeItem(KEYS[k]); } catch (e) {} });
      settings = Object.assign({}, DEFAULT_SETTINGS);
      hfStatus = { token: "none", detection: "unknown", captions: "off", checkedAt: 0 };
      people = []; cars = []; feed = []; zones = []; snapshots = []; lastNotified = {};
      fillSettingsForm();
      renderModeBadge(); renderPeople(); renderCars(); renderFeed(); renderZones(); renderSnapshots(); updateVoiceStatus();
      els.settingsStatus.textContent = "All app data erased.";
    });
    // Delegated buttons inside rendered lists.
    document.addEventListener("click", function (ev) {
      var t = ev.target.closest("button");
      if (!t) return;
      var renameId = t.getAttribute("data-rename-person");
      var forgetPersonId = t.getAttribute("data-forget-person");
      var forgetCarId = t.getAttribute("data-forget-car");
      var deleteZoneId = t.getAttribute("data-delete-zone");
      var saveSnapId = t.getAttribute("data-save-snapshot");
      var deleteSnapId = t.getAttribute("data-delete-snapshot");
      if (saveSnapId) {
        var snapToSave = snapshots.find(function (s) { return s.id === saveSnapId; });
        if (snapToSave) {
          snapToSave.saved = true;
          saveSnapshots();
          renderSnapshots();
          addFeed("memory", "Event snapshot marked saved — it will no longer auto-delete.");
        }
      }
      if (deleteSnapId) {
        snapshots = snapshots.filter(function (s) { return s.id !== deleteSnapId; });
        saveSnapshots();
        renderSnapshots();
        addFeed("memory", "Event snapshot deleted.");
      }
      if (renameId) {
        var person = people.find(function (p) { return p.id === renameId; });
        if (!person) return;
        var name = window.prompt("New name for this person:", person.name);
        if (name && name.trim()) {
          person.name = name.trim();
          savePeople();
          renderPeople();
          addFeed("memory", "Renamed a remembered person to \"" + person.name + "\".");
        }
      }
      if (forgetPersonId) {
        people = people.filter(function (p) { return p.id !== forgetPersonId; });
        savePeople();
        renderPeople();
        addFeed("memory", "Forgot a remembered person (their number signatures and sightings were deleted).");
      }
      if (forgetCarId) {
        cars = cars.filter(function (c) { return c.id !== forgetCarId; });
        saveCars();
        renderCars();
        addFeed("memory", "Forgot a recorded car (its number signature and sightings were deleted).");
      }
      if (deleteZoneId) {
        zones = zones.filter(function (z) { return z.id !== deleteZoneId; });
        saveJson(KEYS.zones, zones);
        renderZones();
        drawOverlay();
      }
    });
    window.addEventListener("resize", fitOverlay);
  }

  /* ---------------- service worker (offline shell) ---------------- */
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return;
    navigator.serviceWorker.register("sw.js").catch(function () {
      /* Offline caching is a bonus; the app works without it. */
    });
  }

  /* Startup animation ("TWEAKER CAMERA" blocks): the overlay fades
     away on its own via CSS even if this code never runs. This only
     adds tap-to-skip, Escape-to-skip, and removal from the page so the
     intro can never block the app. */
  function initIntro() {
    var overlay = document.getElementById("introOverlay");
    if (!overlay) return;
    var done = false;
    function clearIntro() {
      if (done) return;
      done = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function skipIntro() {
      overlay.classList.add("skipped");
      setTimeout(clearIntro, 250);
    }
    overlay.addEventListener("click", skipIntro);
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        skipIntro();
        document.removeEventListener("keydown", onKey);
      }
    });
    overlay.addEventListener("animationend", function (e) {
      if (e.animationName === "introHide") clearIntro();
    });
    setTimeout(clearIntro, 2200); // hard backstop: intro never blocks the app
  }

  /* ---------------- init ---------------- */
  initIntro();
  detectNativeBackgroundWatch();
  updateNotifyStatus();
  fillSettingsForm();
  renderModeBadge();
  renderHfSettingsStatus();
  renderSetupCard();
  // A saved token auto-connects on open too: validate it now (no
  // inference call, no camera frame) and update the badge when done.
  if (settings.hfToken) validateHfConnection();
  renderPeople();
  renderCars();
  renderFeed();
  renderZones();
  sweepSnapshots(true); // drop expired unsaved snapshots from earlier sessions
  renderSnapshots();
  setInterval(function () { sweepSnapshots(false); renderSnapshots(); }, 60000);
  updateVoiceStatus();
  bindEvents();
  positionNavIndicator(); // place the rail pill behind the initially-active tab
  bindZoneDrawing();
  registerServiceWorker();
  fitOverlay();
  addFeed("system", "Tweaker Camera opened. " +
    (settings.hfToken ? "Checking the saved Hugging Face connection…" : "Local-only mode: no token saved."));
})();
