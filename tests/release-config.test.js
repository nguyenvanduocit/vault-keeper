import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("release config", () => {
  test("syncs and commits the Claude plugin manifest version", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
    const pluginManifest = JSON.parse(
      readFileSync(".claude-plugin/plugin.json", "utf-8"),
    );
    const releaseConfig = JSON.parse(readFileSync(".releaserc.json", "utf-8"));
    const plugins = releaseConfig.plugins;

    expect(pluginManifest.version).toBe(packageJson.version);

    const execPlugin = plugins.find((plugin) => plugin[0] === "@semantic-release/exec");
    expect(execPlugin).toBeTruthy();
    expect(execPlugin?.[1]?.prepareCmd).toBe(
      "node scripts/sync-plugin-version.mjs ${nextRelease.version}",
    );

    const gitPlugin = plugins.find((plugin) => plugin[0] === "@semantic-release/git");
    expect(gitPlugin?.[1]?.assets).toContain(".claude-plugin/plugin.json");
    expect(existsSync("scripts/sync-plugin-version.mjs")).toBe(true);
  });
});
