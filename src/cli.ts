#!/usr/bin/env node

import { realpathSync, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplicationExportFormat } from "./export/application-export.js";
import { writeApplicationExport } from "./export/application-export.js";
import { startServeCommand } from "./server/serve-command.js";
import { SqliteApplicationStore } from "./storage/sqlite-application-store.js";

interface ExportCommandOptions {
  databasePath: string;
  outputPath: string;
  format: ApplicationExportFormat;
  applicationId?: string;
  force: boolean;
}

export async function runCli(
  arguments_: string[],
  output: (message: string) => void = (message) => console.log(message),
): Promise<void> {
  if (arguments_[0] === "serve") {
    const running = await startServeCommand(arguments_.slice(1), output);
    try {
      await waitForShutdownSignal();
    } finally {
      await running.server.close();
    }
    return;
  }

  const options = parseExportCommand(arguments_);
  const databasePath = resolve(options.databasePath);
  const outputPath = resolve(options.outputPath);
  if (databasePath === outputPath) throw new Error("export_path_matches_database");

  let databaseStats: Stats;
  try {
    databaseStats = await stat(databasePath);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error("database_not_found");
    throw error;
  }
  if (!databaseStats.isFile()) throw new Error("database_not_file");

  const store = new SqliteApplicationStore(databasePath);
  try {
    const bundle = await writeApplicationExport(store, {
      outputPath,
      format: options.format,
      applicationId: options.applicationId,
      force: options.force,
    });
    output(`Exported ${bundle.applications.length} application(s) to ${outputPath}`);
  } finally {
    store.close();
  }
}

function parseExportCommand(arguments_: string[]): ExportCommandOptions {
  if (arguments_[0] !== "export") throw new Error(`usage:${usage()}`);
  let databasePath: string | undefined;
  let outputPath: string | undefined;
  let format: ApplicationExportFormat | undefined;
  let applicationId: string | undefined;
  let force = false;

  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--force") {
      force = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing_argument_value:${argument}`);
    index += 1;
    if (argument === "--db") databasePath = value;
    else if (argument === "--out") outputPath = value;
    else if (argument === "--application") applicationId = value;
    else if (argument === "--format" && (value === "json" || value === "markdown")) format = value;
    else if (argument === "--format") throw new Error(`unsupported_export_format:${value}`);
    else throw new Error(`unknown_argument:${argument}`);
  }

  if (databasePath === undefined) throw new Error("missing_argument:--db");
  if (outputPath === undefined) throw new Error("missing_argument:--out");
  if (format === undefined) throw new Error("missing_argument:--format");
  return { databasePath, outputPath, format, applicationId, force };
}

function usage(): string {
  return [
    "boss-watch serve [--port 4318] [--data-dir <path>]",
    "boss-watch export --db <path> --out <path> --format <json|markdown> [--application <id>] [--force]",
  ].join("\n");
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && isEntrypoint(entrypoint)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isEntrypoint(path: string): boolean {
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
