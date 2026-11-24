# Security model — Tweaker Camera

## What data exists

| Data | Where it lives | What it is |
|---|---|---|
| Settings (incl. Hugging Face token, if saved) | This browser's `localStorage` | The user's own choices. The token is stored only here, never in a file, never in code, never in a URL. |
| Remembered people | This browser's `localStorage` | Name given by the user, rough number signatures (hash + histogram numbers only), first/last seen times, sighting timestamps. No reference photos are stored. |
| Recorded cars | This browser's `localStorage` | Rough number signatures, sighting timestamps, the user's "lives around here?" answer. No pictures are stored for cars. No plates are read. |
| Enrollment pictures (transient) | Memory only — never written to storage | One frame shown while the app asks who someone new is, or whether a new car lives around here. Deleted straight away once the user answers or cancels. Never enters the event-snapshot gallery. |
| Event snapshots | This browser's `localStorage` | ONE still JPEG per triggering event (zone intrusion or suspicious activity only), capture time, reason, saved flag. At most 20. Unsaved ones auto-delete after the retention window (default 6 hours). Never uploaded anywhere. |
| Watch zones | This browser's `localStorage` | Rectangles drawn by the user, as fractions of the preview. |
| Activity log | This browser's `localStorage` | Timestamped text entries (sightings, alerts, answers). Capped at 200 entries. |
| Cooldown state | This browser's `localStorage` | Last-alert time per person / zone, so repeat alerts stay suppressed. |

There is no account, no server, no analytics, and no third-party script.
The app works fully offline except for the camera stream and (optionally)
Hugging Face.

## Live feed first — watching records nothing; event stills are the one exception

The AI watches the running live video. Each analysis frame is drawn from
the live video element to an offscreen canvas held in memory only, at the
configured sample rate (default 1 frame per second), analysed, and then
discarded when the next frame replaces it. **Watching alone records
nothing: no video is recorded, ever.**

The one exception is event snapshots: a single still is captured from the
live frame ONLY when (a) a person is inside a circled watch zone, or
(b) suspicious activity is flagged (the repeat-car question, an unknown
person lingering, or motion + person detection inside a zone). That still
is shown with the alert and stored in this browser only, at most 20, and
auto-deletes after the retention window (default 6 hours, changeable in
Settings) unless the user taps Save on it. An expiry sweep runs on app
start and every minute while open. No continuous recording happens, and
no snapshot is taken at any other time.

**The distinction, plainly: "tells you about everyone, photographs only
zone/suspicious events."** Notifications — spoken, on-screen, and in the
log — cover every person the camera sees, in or out of a zone, once per
cooldown window. The snapshot restriction never limits notifications;
only the saved pictures are limited.

When meeting someone or something new, the app shows you one picture to
ask who it is, saves only the name or answer and matching numbers, and
deletes the picture straight away — on saving and on cancelling alike.
That enrollment picture lives in memory only and is never written to
storage: the picture data is dropped the moment the prompt resolves, and
every person/car record passes through a `stripImageData` guard before
saving, which drops any image field, so a reference photo cannot reach
storage even by accident, and no enrollment photo can survive saving or
cancelling. The same rule covers new cars: one picture is shown with the
"Does this car live around here?" question, the answer and signature are
saved, and the picture is deleted straight away. The only thing kept for
a remembered person or car is the numeric signature plus the name/answer
and timestamps. Enrollment pictures never enter the event-snapshot
gallery — that gallery holds only zone/suspicious stills, which delete
after 6 hours unless saved. The still-refresh fallback for cameras that
only offer still pictures refreshes the live picture as fast as the
camera allows; those stills are likewise never saved (they are not event
snapshots).

## What leaves the device

Exactly one thing, and only when the user opts in:

- **Live-feed frames sent to Hugging Face** — frames drawn from the
  running live feed, only while a camera is connected, at most one frame
  every 3 seconds, and only if the user saved a Hugging Face token in
  Settings. Frames go to
  `https://api-inference.huggingface.co/models/<model-id>` with the token
  as a Bearer header. Hugging Face's handling of those frames is governed
  by Hugging Face's own terms and privacy policy; assume a frame sent there
  is processed on their infrastructure. Frames are sent from memory and
  are not stored by the app before or after sending.

Everything else stays on the device:

- **No data is sent to any other service.** No crash reports, no analytics,
  no telemetry, no advertising SDKs.
- **No internet face lookup.** Nobody is searched for, matched against, or
  identified using any online database, social media, or any other source.
  The only "recognition" is comparing a new number signature against
  signatures the user personally labelled, on this device. No pictures
  are compared for recognition; the only stored pictures are the event
  snapshots described above.
- **No plate lookup.** Plates are never read and never checked anywhere.
- **Event snapshots never leave the device.** They are stored in this
  browser only and are never uploaded, including never to Hugging Face.
  The only frames that leave the device are the in-memory analysis frames
  sent to Hugging Face when the user supplied a token, and those are
  never stored.
- **Camera streams** go directly from the user's camera to this page. The
  app does not proxy, record, or re-upload the stream.
- **Bluetooth** is not used at all. The app makes no Bluetooth connections
  and claims none.

## What the matching can and cannot do

Signatures are an 8×8 average hash plus a brightness histogram computed
from a crop of the live frame, kept as numbers only. They are deliberately
rough. They can confuse two people in similar lighting, and miss the same
person in different lighting. That is why every match is presented as a
suggestion the user confirms or corrects, and why unconfirmed matches keep
asking. Do not use this app as evidence about who someone is, and do not
point it at people who have not agreed to be filmed where that matters —
follow local law for cameras that overlook shared or public space.

## Spoken alerts and staying awake

Spoken alerts use the device's own speech synthesis; the spoken words are
generated on the device and no audio or text is sent anywhere. The screen
Wake Lock only prevents the screen from sleeping while the watch page is
visible; it sends nothing anywhere. Web Notifications, if allowed, show
alert text in a system notification when the page is hidden — that text is
the same alert text already shown on screen. None of these features keeps
the camera running while the page is hidden or the phone is locked; the
browser pauses the camera in that state, and the app does not claim
otherwise. True background watching needs the native foreground-service
build described in [docs/build-apk.md](build-apk.md).

## Deletion

- **Enrollment pictures:** deleted automatically the moment the "Who is
  this?" / "Does this car live around here?" prompt is answered or
  cancelled. They are never stored, so there is nothing to delete later.
- **Forget one person/car:** the People and Cars tabs have Forget buttons
  that delete that entry's number signatures and sightings. (There are no
  stored reference photos to delete.)
- **Event snapshots:** each snapshot in the Log tab has Save (exempts it
  from auto-delete, marked "saved") and Delete (removes it at once).
  Unsaved snapshots delete themselves after the retention window even if
  the app is closed and reopened later — the sweep runs on start.
- **Remove the token:** Settings → "Remove saved token".
- **Erase everything:** Settings → "Erase all app data" removes settings,
  people, cars, zones, log, and cooldown state from this browser.
- **Uninstalling** the PWA / clearing the browser's site data for this
  origin removes the same data. There is no server copy to chase.

## If the device is shared

Anyone who can open this app in this browser can see the remembered people,
cars, and log, and can change settings. Do not save a Hugging Face token on
a device you do not control. On a shared device, use a separate browser
profile or do not save a token (local-only mode still watches, counts, and
remembers names without sending frames anywhere).

## Limits of the protection

- `localStorage` is not encrypted. Someone with access to the unlocked
  device or browser profile can read the stored signatures, names, log,
  token, and event snapshots. This app does not claim otherwise. (The
  only stored pictures are the event snapshots, which auto-delete unless
  saved.)
- The Hugging Face token has whatever permissions the user gave it on
  Hugging Face. Use a read-only token and rotate it if it is ever exposed.
- Obfuscation is not protection: the app is plain web code, readable by
  design. Security here comes from keeping data local and sending as
  little as possible — not from hiding code.
