import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HttpBossHunterBrowserRuntime } from "../browser/bosshunter-runtime-client.js";
import type { BossHunterBrowserRuntime } from "../browser/browser-run-controller.js";
import { createLocalApiServer, type LocalApiAddress, type LocalApiServer } from "./local-api-server.js";
import { ensureDshServiceToken } from "./service-token.js";

export interface RunningLocalService {
  server: LocalApiServer;
  address: LocalApiAddress;
  databasePath: string;
  serviceTokenPath: string;
}

export async function startServeCommand(
  arguments_: string[],
  output: (message: string) => void = (message) => console.log(message),
  testOptions: {
    pairingCode?: string;
    serviceToken?: string;
    browserRuntime?: BossHunterBrowserRuntime;
  } = {},
): Promise<RunningLocalService> {
  const options = parseServeCommand(arguments_);
  const databasePath = join(options.dataDir, "boss-watch.sqlite3");
  const serviceTokenPath = join(options.dataDir, "dsh-service-token");
  const serviceToken = await ensureDshServiceToken(serviceTokenPath, testOptions.serviceToken);
  const server = createLocalApiServer({
    databasePath,
    pairingCode: testOptions.pairingCode,
    runtimeMode: "baseline_ready",
    browserRuntime: testOptions.browserRuntime ?? new HttpBossHunterBrowserRuntime(),
    serviceToken,
    ...dshWebOriginOptions(process.env),
    resumeRoot: process.env.BOSS_WATCH_RESUME_DIR,
    progressSignalRoot: process.env.BOSS_WATCH_PROGRESS_SIGNAL_DIR,
  });

  try {
    const address = await server.start({ port: options.port });
    output(`Boss Watch listening at ${address.origin}`);
    output(`Database: ${databasePath}`);
    output("Analysis mode: baseline_ready (Pi model is not configured)");
    output(`Pairing code: ${server.pairingCode} (expires ${server.pairingExpiresAt.toISOString()})`);
    return { server, address, databasePath, serviceTokenPath };
  } catch (error) {
    await server.close();
    if (isAddressInUseError(error)) throw new Error(`port_in_use:${options.port}`);
    throw error;
  }
}

function dshWebOriginOptions(environment: NodeJS.ProcessEnv): {
  dshWebOrigin?: string;
  dshWebOrigins?: readonly string[];
} {
  if (environment.BOSS_WATCH_DSH_WEB_ORIGINS !== undefined) {
    return {
      dshWebOrigins: environment.BOSS_WATCH_DSH_WEB_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    };
  }
  return environment.BOSS_WATCH_DSH_WEB_ORIGIN === undefined
    ? {}
    : { dshWebOrigin: environment.BOSS_WATCH_DSH_WEB_ORIGIN };
}

function parseServeCommand(arguments_: string[]): { port: number; dataDir: string } {
  let port = 4318;
  let dataDir = join(homedir(), "Library", "Application Support", "BossWatchAgent");

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing_argument_value:${argument}`);
    index += 1;
    if (argument === "--port") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535)
        throw new Error(`invalid_port:${value}`);
      port = parsed;
    } else if (argument === "--data-dir") {
      if (value.trim().length === 0) throw new Error("invalid_data_dir");
      dataDir = resolve(value);
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }

  return { port, dataDir };
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
