import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
assert.equal(manifest.default_locale, "en");

for (const locale of ["en", "ko"]) {
  JSON.parse(await readFile(`dist/_locales/${locale}/messages.json`, "utf8"));
}

for (const size of [16, 32, 48, 128]) {
  const path = `icons/icon-${size}.png`;
  assert.equal(manifest.icons[String(size)], path);
  assert.equal(manifest.action.default_icon[String(size)], path);
  const png = await readFile(`dist/${path}`);
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}

console.log("Build verification passed.");
