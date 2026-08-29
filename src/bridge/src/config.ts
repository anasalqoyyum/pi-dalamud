import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { z } from "zod";

const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((token) => {
    try {
      return Buffer.from(token, "base64url").length >= 32;
    } catch {
      return false;
    }
  }, "token must contain at least 32 random bytes");

const storedConfigSchema = z.strictObject({
  version: z.literal(1),
  port: z.number().int().min(1).max(65_535),
  token: tokenSchema,
  workspace: z.string().refine(isAbsolute, "workspace must be absolute"),
  sessionDirectory: z
    .string()
    .refine(isAbsolute, "sessionDirectory must be absolute"),
});

export type BridgeConfig = z.infer<typeof storedConfigSchema> & {
  readonly host: "127.0.0.1";
};

type LoadBridgeConfigOptions = {
  readonly configPath: string;
  readonly initialWorkspace?: string;
};

export type LoadedBridgeConfig = {
  readonly config: BridgeConfig;
  readonly created: boolean;
  readonly configPath: string;
};

export function defaultConfigPath(environment: NodeJS.ProcessEnv): string {
  const baseDirectory =
    environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return resolve(baseDirectory, "pi-dalamud", "bridge.json");
}

export async function loadBridgeConfig(
  options: LoadBridgeConfigOptions,
): Promise<LoadedBridgeConfig> {
  const configPath = resolve(options.configPath);
  let created = false;
  let stored: z.infer<typeof storedConfigSchema>;

  try {
    const decoded: unknown = JSON.parse(await readFile(configPath, "utf8"));
    const parsed = storedConfigSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("Bridge configuration is invalid");
    stored = parsed.data;
  } catch (error: unknown) {
    if (!isFileNotFound(error)) throw error;
    if (!options.initialWorkspace) {
      throw new Error(
        "Bridge configuration does not exist. Set PI_DALAMUD_WORKSPACE for the first start.",
      );
    }

    const workspace = await realpath(resolve(options.initialWorkspace));
    const sessionDirectory = join(dirname(configPath), "sessions");
    stored = {
      version: 1,
      port: 32_145,
      token: randomBytes(32).toString("base64url"),
      workspace,
      sessionDirectory,
    };
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    created = true;
  }

  const workspace = await realpath(stored.workspace);
  if (!(await stat(workspace)).isDirectory()) {
    throw new Error(
      "Bridge configuration is invalid: workspace must be a directory",
    );
  }
  const configDirectory = dirname(configPath);
  const sessionDirectory = resolve(stored.sessionDirectory);
  if (!sessionDirectory.startsWith(`${configDirectory}${sep}`)) {
    throw new Error(
      "Bridge configuration is invalid: sessionDirectory must be bridge-owned",
    );
  }

  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(sessionDirectory, 0o700);
  await chmod(configPath, 0o600);

  return {
    created,
    configPath,
    config: {
      ...stored,
      host: "127.0.0.1",
      workspace,
      sessionDirectory,
    },
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}
