# Tweaker Camera

Watch **your own** cameras with an AI vision model from Hugging Face. The app
remembers people and cars **you** name, watches areas **you** draw, and tells
you once per cooldown window instead of repeating itself.

Local build only. Nothing here has been pushed anywhere, and no APK has been
produced on this machine (see [docs/build-apk.md](docs/build-apk.md)).

## What it does

1. **Live feed first — watching saves nothing.** The app looks at the
   live picture, then throws it away. Default: 1 check per second.
   The ONE exception is saved pictures (see below): one picture, only
   for a person in a zone or strange activity. It stays on this phone
   only. It deletes after 6 hours unless saved. People memory keeps
   ONLY numbers — no photos.
   **Everyone gets an alert. Only zone or strange events get a picture.**
   Every person seen gets an alert, once per wait time, in or out of a
   zone. The picture rule never limits alerts.
   Cameras — this phone's camera, or a Wi-Fi camera with a live web
   address (MJPEG or HLS). A camera with stills only is a clearly
   labelled fallback — never called a live stream.
   No Bluetooth video: Bluetooth is too slow for video, and the app
   says so instead of faking it.
2. **Hugging Face AI** — with your token saved in Settings, pictures
   from the live feed go to Hugging Face. It finds people and cars, and
   can describe what it sees. No token? The app still works. Motion
   only. No AI names.
3. **People memory** — a new person gets asked "Who is this?" One
   picture shows while you answer. Your name is saved with ONLY numbers.
   The picture is **deleted right away** — on save and on cancel. It is
   never stored. Later, the app **suggests** that name. You confirm it.
4. **Traffic monitor** — cars passing are counted. A new car shows one
   picture and asks *"Does this car live near here?"* Your answer and
   numbers are saved. The picture is **deleted right away**. A car seen
   3 times in 7 days asks again (at most once a week) if still unanswered.
5. **Watch zones** — draw boxes on the live picture. A person in a box
   gets an alert AND one picture is saved. Movement outside a box is
   only logged — but a *person* outside a box is still announced. Boxes
   limit pictures, never alerts.
6. **Wait time** — the same person gets at most one alert per wait
   time (default 30 minutes), in a zone or not. Repeat sightings are
   logged, not repeated.
7. **Voice** — ask "Who was here today?", "Any repeat cars this week?",
   "How many cars?", or "What do you see?" Answers come from the log,
   spoken and shown. Browser support varies. The app says so when voice
   is not there.
8. **Spoken alerts** — every alert is spoken, one at a time, never
   talking over itself. Same wait time as on-screen alerts. Settings:
   on/off, voice, speed, "alerts only" or "alerts and answers". The
   screen stays awake while you watch.
9. **Background, plainly** — a browser page can't keep the camera on
   when hidden or locked. Alerts can still pop up when the page is
   hidden. The camera itself stops. Real background watching needs the
   Android app. See [docs/build-apk.md](docs/build-apk.md). The app
   says all this in plain words.
10. **Settings** — token, model names, wait time, repeat number,
   movement level, check rate, zones on/off, voice on/off, spoken
   alerts. All saved only on this phone.

## Run it

No build step. Serve the folder over HTTP (camera access needs a secure
context — `localhost` counts) and open `index.html`:

```sh
cd camera-watch-ai
python3 -m http.server 8000
# open http://localhost:8000/
```

Or: `npm run serve`. Install as a PWA from the browser menu if you want it
on a home screen. A service worker caches the app shell for offline loading;
camera streams and Hugging Face calls always use the network.

## Start in 3 steps

The Watch tab opens with a **Start in 3 steps** card. One short line
per step. Each step has a button that jumps to the right control, and
a check when it is really done:

1. **Connect a camera** — this phone's camera, or a Wi-Fi camera web
   address (see "Add a Wi-Fi camera" below). Done when a camera is
   ready.
2. **Type in the token** — put your Hugging Face token in Settings.
   The models connect by themselves the moment it checks out. No
   token? This step stays unchecked. The app runs motion-only.
3. **Start it** — tap Start. Done while a camera is watching.

The card folds away the first time you start watching with all three
done. Hide or show it any time. That choice is remembered.

## Add a Wi-Fi camera

1. Open the **Watch** tab, choose "Wi-Fi camera".
2. Pick the kind your camera has:
   - **Live stream** — a live MJPEG web address, e.g. `http://192.168.1.50:8080/video`
   - **Stills only (fallback)** — only if the camera has nothing but a
     still-picture address, e.g. `http://192.168.1.50:8080/snapshot.jpg`.
     New picture every 2 seconds. Labelled plainly: not live video.
     No still is ever saved.
   - **Live video (.m3u8)** — plays in Safari. Other browsers may not
     play it. No player is built in.
3. Type the address and tap **Connect**.

Notes:

- Use the camera's address on your own network. A camera behind a login
  page on the open internet will not stream here.
- Many cameras block picture checks (no CORS headers). The live picture
  still shows, but the app can't read the pixels, so motion and AI
  checks are off for that camera. The app says so. If your camera has
  a CORS setting, allow the address you serve this app from.
- Stills only is the slowest (one picture every 2 seconds). It can miss
  a fast passer-by. Live streams are better for counting cars.

## Asking pictures — shown once, deleted right away, never saved

New person or new car? The app shows one picture to ask who it is. It
saves only the name or answer and numbers. The picture is deleted right
away — on save **and** on cancel. Asking pictures are never stored,
never enter the saved-pictures gallery, and can't outlive the question.
Every saved record passes through a guard (`stripImageData` in
`logic.js`) that strips any picture before saving.

## Saved pictures — the only pictures ever saved

- **Only these:** (a) a person in a zone, or (b) strange activity — a
  repeat car, an unknown person on screen a long time (several checks
  over at least 20 seconds), or movement + person in a zone. Nothing
  else. No always-on recording.
- **One picture per event**, shown with the alert. On this phone only.
  At most 20 kept. Oldest unsaved ones go first.
- **Deletes after 6 hours** (change it in Settings, 1–168 hours)
  unless you tap **Save**. Saved pictures stay. A sweep runs on start
  and every minute. The Log tab shows age and time left, with Save and
  Delete.
- **Never uploaded.** Only live pictures sent to Hugging Face ever leave
  this phone — and only with your token. Those are never stored.
- **Alerts are not limited by this.** You hear about every person, in
  or out of a zone, once per wait time. Only pictures are limited.

## Hugging Face setup (optional)

1. Make a free account at huggingface.co. Make a token with **read**
   access (Settings → Access Tokens). Never type it in a file — put
   it in Settings in the app.
2. **The models connect by themselves.** Save a good token and the app
   checks it and each model, then starts using them. No extra button.
   A watch already running picks them up on the next live picture. The
   check sends no camera picture and costs no AI call. "Connected"
   always means the model is really running, for each half (finding /
   describing). If it fails, the app says so, stays motion-only (or
   finding-only), and does not retry on its own. Save again to retry.
   The token is never shown in full (only `hf_…last4`), never logged.
3. Defaults (change them in Settings):
   - Finding: `facebook/detr-resnet-50` — checked running: the public
     models API shows it live (checked 2026-11-23).
   - Describing: **off** (no model name). The old default,
     `Salesforce/blip-image-captioning-base`, is **not** running
     anywhere — its page says so, and the public API shows nothing for
     it. Same for the large version, vit-gpt2 captioning, and
     git-base-coco. Until you type a describing model name that IS
     running, the app says plain words ("Sees: person (92%), car
     (81%)"). It never claims a describing model answered when it
     did not.
4. Calls go to Hugging Face with your token and the picture. If a model
   is waking up (503) or the token is refused (401/403), the app logs
   the plain error and keeps going locally. Nothing is faked.
5. Free limits apply. At most one picture every 3 seconds, only while
   a camera is on, and only for halves that checked out.

## How matching works (and what it is not)

A "signature" is an 8×8 average hash plus an 8-bin brightness histogram of
the detected crop (see `logic.js`). Two crops match when the hash differs in
at most 10 of 64 bits **and** the histograms are close. That is enough to
suggest "this looks like the person you named before" — and the user always
confirms or corrects. It is **not** face recognition, **not** plate
recognition, and it never identifies anyone the user has not named. Lighting
and angle changes can fool it in both directions; treat every suggestion as
a guess.

## Tests

```sh
node tests/run-tests.mjs
```

The tests cover the pure logic in `logic.js`: cooldown decisions, 7-day
counting and the repeat threshold, signature hashing/similarity, watch-zone
hit tests, vehicle pass debouncing, the `stripImageData` save-boundary
guard (proving no image data survives in a stored people/car record),
event-snapshot expiry (unsaved snapshots expire after the retention window;
saved ones never do), and the Hugging Face helpers — `modelDeploymentLive`
(a model counts as callable only with a `live` Inference Provider entry;
an empty mapping means not deployed) and `maskToken` (only `hf_…last4`
is ever shown). See the build report for the pass/fail counts from
the run that shipped with this code.

## Honest limits

- **No Bluetooth video.** Bluetooth is too slow for live video.
- **Watching live saves nothing. Saved pictures only.** Live pictures
  are looked at, then thrown away. A new person gets one picture to
  ask who they are, then it is deleted right away — never saved. One
  picture is saved only for a zone event or strange activity. On this
  phone only. Deletes after 6 hours unless saved. Only numbers are
  kept for people. Alerts are not limited this way: you hear about
  everyone, in or out of a zone.
- **No background watching in the browser.** The camera stops when the
  page is hidden or the phone locks. Real background watching needs
  the Android app (see [docs/build-apk.md](docs/build-apk.md)).
- **No naming strangers.** Nobody and no plate is looked up online —
  ever.
- **Rough matching only.** Numbers can mismatch. Your yes is the only
  thing that makes a name stick.
- **No token, no AI.** No token means no AI names and no describing —
  motion only.
- **Describing is off.** No describing model could be checked as
  running (see the Hugging Face section). "Connected" always means
  checked and running, for each half. Settings says what works.
- **Blocked cameras** show live video only (see above).
- **HLS** plays in Safari only, with no added player.
- **Voice** depends on the browser (Chrome/Edge desktop and Android
  Chrome do it; Firefox and Safari mostly do not). Spoken alerts work
  more widely.
- **Not 24/7.** The app checks the live picture while the page is open
  and the camera is on. Close the page and watching stops. Nothing
  records in the background.
- **No APK here.** A real APK needs Android Studio / Capacitor on a
  real machine. See [docs/build-apk.md](docs/build-apk.md).
- **Privacy.** See [docs/security-model.md](docs/security-model.md).

## File map

| File | What it is |
|---|---|
| `index.html` | The whole interface (Watch / People / Cars / Log / Settings). No external libraries or CDNs. |
| `app.js` | Camera handling, motion detection, Hugging Face calls, memory, zones, cooldowns, voice. |
| `logic.js` | Pure, testable logic: cooldown, weekly counting, signatures, zone hit tests, pass debouncing. |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | PWA install + offline app-shell cache. |
| `capacitor.config.json`, `scripts/prepare-www.mjs`, `android/.../proguard-rules.pro` | Capacitor wrapper so the same web app can become an Android app on a real machine. |
| `tests/run-tests.mjs` | Node tests for `logic.js`. |
| `docs/security-model.md` | What data exists, where it lives, what leaves the device. |
| `docs/build-apk.md` | Honest steps to build a real APK elsewhere. |
