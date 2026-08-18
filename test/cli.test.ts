import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { SqliteApplicationStore } from "../src/storage/sqlite-application-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boss-watch-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("boss-watch CLI", () => {
  it("exports an existing local database on explicit request", async () => {
    const directory = await workspace();
    const databasePath = join(directory, "applications.sqlite3");
    const outputPath = join(directory, "applications.json");
    new SqliteApplicationStore(databasePath).close();
    const messages: string[] = [];

    await runCli(["export", "--db", databasePath, "--out", outputPath, "--format", "json"], (message) =>
      messages.push(message),
    );

    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      applications: [],
    });
    expect(messages).toEqual([`Exported 0 application(s) to ${outputPath}`]);
  });

  it("refuses to create a database when the input path is wrong", async () => {
    const directory = await workspace();
    const missingPath = join(directory, "missing.sqlite3");

    await expect(
      runCli(["export", "--db", missingPath, "--out", join(directory, "out.json"), "--format", "json"]),
    ).rejects.toThrow("database_not_found");
  });

  it("refuses to overwrite the database with its own export", async () => {
    const directory = await workspace();
    const databasePath = join(directory, "applications.sqlite3");
    new SqliteApplicationStore(databasePath).close();

    await expect(
      runCli(["export", "--db", databasePath, "--out", databasePath, "--format", "json"]),
    ).rejects.toThrow("export_path_matches_database");
  });
});
