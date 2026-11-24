# Building a real APK — honest steps

**No APK was produced on the machine that built this web app.** The VM
where this code was written has no Android SDK and no Android Studio, and
no APK was faked or claimed. The files in this folder are the complete
web app plus the Capacitor wrapper configuration, so a real APK can be
built on a real machine by following the steps below.

## What you need on a real machine

- Node.js 18 or newer, and npm.
- Java 17 (required by current Android Gradle builds).
- Android Studio (includes the Android SDK, SDK Platform, and build tools),
  **or** the standalone Android SDK command-line tools with a platform and
  build-tools package installed and `ANDROID_HOME` set.
- A USB cable / a test Android phone for installing, or an emulator from
  Android Studio.
- About 30 minutes the first time, mostly SDK downloads.

## Steps

1. **Copy this folder** (`camera-watch-ai`) to the machine with Android
   Studio. Everything the app needs is in it; there are no other sources.

2. **Install the Capacitor tooling** (from inside the folder):

   ```sh
   npm install
   npm install @capacitor/core @capacitor/cli @capacitor/android
   ```

   These packages are not vendored here and are not installed in this repo.

3. **Prepare the web folder:**

   ```sh
   npm run prepare-www
   ```

   This copies `index.html`, `app.js`, `logic.js`, `manifest.webmanifest`,
   `icon.svg`, and `sw.js` into `www/` (the folder Capacitor packages).

4. **Generate the Android project** (first time only):

   ```sh
   npx cap add android
   npx cap sync android
   ```

   This creates `android/` with a standard Capacitor Android project. The
   checked-in `android/app/src/main/proguard-rules.pro` is a starting point;
   the generated project supplies the rest (manifest, Gradle files). If the
   generator overwrites the rules file, keep whichever copy is present —
   the app has no native code and no secrets to protect with obfuscation.

5. **Permissions.** The generated `AndroidManifest.xml` needs camera and
   network access for this app to work. Capacitor's defaults plus the
   following (added by hand if absent):

   ```xml
   <uses-permission android:name="android.permission.CAMERA" />
   <uses-permission android:name="android.permission.INTERNET" />
   <uses-permission android:name="android.permission.RECORD_AUDIO" />
   <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
   ```

   `RECORD_AUDIO` is only for the optional voice questions. The app must
   still request these permissions at runtime on Android 6+; the WebView
   permission prompt handles the camera and microphone requests.

6. **Open in Android Studio** (`File → Open`, choose the `android/`
   folder), let Gradle sync, then **Build → Build Bundle(s) / APK(s) →
   Build APK(s)**. The debug APK lands in
   `android/app/build/outputs/apk/debug/app-debug.apk`.

7. **Install on the phone:** copy the APK to the phone and open it (allow
   "install unknown apps" for the file manager / browser you use), or use
   `adb install app-debug.apk` with the phone connected.

8. **For a release APK** (to share or publish), create a signing key with
   `keytool`, configure `signingConfigs` in Gradle, and build a release
   APK/AAB. Never commit the keystore or its passwords to any repository.

## After every web change

```sh
npm run prepare-www
npx cap sync android
```

then rebuild in Android Studio.

## Things that behave differently in the APK

- **Camera access** goes through the Android WebView permission prompt;
  grant Camera (and Microphone if voice questions are wanted).
- **HTTP (non-HTTPS) camera URLs** on the local network: Android WebView
  with `androidScheme: https` (see `capacitor.config.json`) can block
  cleartext `http://` stream URLs. Prefer `https://` camera URLs, or serve
  the camera over a local HTTPS reverse proxy. `localhost` streams are
  fine. If a Wi-Fi camera only offers plain HTTP, test it first — this is
  the most common reason a stream works in a desktop browser but not in
  the packaged app.
- **Background watching does not exist in the plain WebView build.**
  Android may pause the WebView when the app is in the background; the
  app only watches while open and in the foreground. There is no
  background service in this build.

## Optional: true background watching (foreground-service integration point)

The browser build is honest that it cannot watch while backgrounded or
locked. If — and only if — the native build adds a foreground service,
the web code is already prepared for it:

1. **Native side (build machine only).** Add a foreground service to the
   generated Android project (for example with a Capacitor foreground-service
   plugin, or a small native `Service` started with
   `startForeground()` and a persistent notification, holding a partial
   wake lock). The service must keep the WebView/camera session alive and
   must show Android's ongoing-notification while running — that is an
   Android requirement, not an option. This service is **not** included
   in this repo: it is native code that has to be written and audited on
   the build machine.
2. **The hook.** The web app exposes `window.CameraWatchBackground` with
   a `nativeForegroundService` flag and a `supported()` check
   (see `app.js`, "staying awake & background honesty"). The app sets the
   flag only when `window.Capacitor.Plugins.ForegroundService` exists at
   runtime. The plugin's registered name must therefore be exactly
   `ForegroundService` for the flag to turn on. No other wiring is needed
   in the web code: when the flag is on, the app knows a native service
   is keeping it alive; when it is off, the app degrades gracefully to
   screen wake-lock + web notifications and says so in the interface.
3. **What the service must NOT do.** It must not record video or save
   snapshots: the live-feed-only rule in `docs/security-model.md` applies
   in the native build too. The service keeps the existing watch session
   alive; it does not add recording.
4. **Permissions the service needs** (add to `AndroidManifest.xml` on the
   build machine, in addition to the permissions in step 5 above):

   ```xml
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
   <uses-permission android:name="android.permission.WAKE_LOCK" />
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
   ```

   On Android 14+, a foreground service with camera access needs the
   `FOREGROUND_SERVICE_CAMERA` type declared on the `<service>` element
   and a visible notification. Test on the target Android version —
   background camera access is restricted and version-dependent, and this
   document does not promise it works on every device.

Do not ship a build that claims background watching unless this service
is actually present and tested on the phone. The default build without
it watches only while open, and the interface says so.
- **Speech recognition** in a WebView depends on the device's speech
  services; if unavailable, voice questions are unavailable but everything
  else works.

## What is NOT claimed

- This document does not claim the APK has been built, tested, or signed.
- The generated Android project is not checked in here; it is produced by
  the Capacitor CLI on the build machine, so what you generate is the
  standard, auditable Capacitor output — not a prebuilt binary from an
  unknown source.
