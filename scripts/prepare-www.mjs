// Copy the web app files into www/ for Capacitor packaging.
// No dependencies. Run: npm run prepare-www  (or: node scripts/prepare-www.mjs)
// The Android project itself is created on a real machine with
// `npx cap add android` — see docs/build-apk.md. Nothing here builds an APK.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www");
const files = ["index.html", "app.js", "logic.js", "manifest.webmanifest", "icon.svg", "sw.js"];

if (existsSync(www)) rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of files) cpSync(join(root, f), join(www, f));
console.log(`Prepared www/ with ${files.length} files.`);
