import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadBridgeConfig } from "../src/config.js";

describe("bridge configuration", () => {
  it("creates a private token file and bridge-owned session directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dalamud-config-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const configPath = join(directory, "private", "bridge.json");

    const result = await loadBridgeConfig({
      configPath,
      initialWorkspace: workspace,
    });

    expect(result.created).toBe(true);
    expect(result.config.host).toBe("127.0.0.1");
    expect(Buffer.from(result.config.token, "base64url")).toHaveLength(32);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.config.sessionDirectory)).mode & 0o777).toBe(
      0o700,
    );
    await expect(access(result.config.workspace)).resolves.toBeUndefined();
  });

  it("loads an existing config without replacing its token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dalamud-config-"));
    const workspace = join(directory, "workspace");
    const configPath = join(directory, "bridge.json");
    await mkdir(workspace);
    const first = await loadBridgeConfig({
      configPath,
      initialWorkspace: workspace,
    });
    await chmod(configPath, 0o644);

    const second = await loadBridgeConfig({ configPath });

    expect(second.created).toBe(false);
    expect(second.config.token).toBe(first.config.token);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("requires a workspace on first run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dalamud-config-"));

    await expect(
      loadBridgeConfig({ configPath: join(directory, "bridge.json") }),
    ).rejects.toThrow(/PI_DALAMUD_WORKSPACE/);
  });

  it("rejects invalid or extensible configuration fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dalamud-config-"));
    const configPath = join(directory, "bridge.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        port: 32145,
        token: "not-random-enough",
        workspace: directory,
        sessionDirectory: join(directory, "sessions"),
        host: "0.0.0.0",
      }),
    );

    await expect(loadBridgeConfig({ configPath })).rejects.toThrow(/invalid/i);
    expect(await readFile(configPath, "utf8")).toContain("0.0.0.0");
  });
});
