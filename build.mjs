import * as esbuild from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";

const distDir = "dist";

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function copyDir(src, dest) {
  await fs.cp(src, dest, { recursive: true });
}

async function copyStaticFiles() {
  await copyFile("src/manifest.json", path.join(distDir, "manifest.json"));
  await copyFile("src/popup/popup.html", path.join(distDir, "popup/popup.html"));
  await copyFile("src/popup/popup.css", path.join(distDir, "popup/popup.css"));
  await copyFile("src/options/options.html", path.join(distDir, "options/options.html"));
  await copyFile("src/options/options.css", path.join(distDir, "options/options.css"));
  await copyDir("src/_locales", path.join(distDir, "_locales"));
  await copyDir("src/icons", path.join(distDir, "icons"));
}

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });

  await esbuild.build({
    entryPoints: [
      "src/background.ts",
      "src/popup/popup.ts",
      "src/options/options.ts",
    ],
    outdir: distDir,
    outbase: "src",
    bundle: true,
    format: "esm",
    target: "chrome110",
    sourcemap: true,
  });

  await copyStaticFiles();

  console.log("Build complete: dist/");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
