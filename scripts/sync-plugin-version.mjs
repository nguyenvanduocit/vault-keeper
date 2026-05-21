#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!version) {
  console.error("Usage: node scripts/sync-plugin-version.mjs <version>");
  process.exit(2);
}

const manifestPath = ".claude-plugin/plugin.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

manifest.version = version;

writeFileSync(
  manifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf-8",
);

console.log(`${manifestPath} version synced to ${version}`);
