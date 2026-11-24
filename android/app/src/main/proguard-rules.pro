# Camera Watch AI — R8 / ProGuard rules.
# This file is only used when the Android project is generated with
# `npx cap add android` on a real machine (see docs/build-apk.md).
# The app ships no native code of its own: all logic is the web app in
# www/. Keep the defaults Capacitor needs; do not add obfuscation rules
# for secrets, because there are none in the app — the Hugging Face
# token is entered by the user at runtime and stored only on-device.

-keepattributes *Annotation*
-dontwarn java.lang.invoke.**
