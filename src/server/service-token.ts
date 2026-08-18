import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TOKEN_BYTES = 32;

export async function ensureDshServiceToken(path: string, requestedToken?: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    validateToken(existing);
    await chmod(path, 0o600);
    return existing;
  } catch (error) {
    if (isNotFoundError(error)) {
      const token = requestedToken ?? randomBytes(TOKEN_BYTES).toString("base64url");
      validateToken(token);
      try {
        await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (writeError) {
        if (!isAlreadyExistsError(writeError)) throw writeError;
        const existing = (await readFile(path, "utf8")).trim();
        validateToken(existing);
        await chmod(path, 0o600);
        return existing;
      }
      return token;
    }
    throw error;
  }
}

function validateToken(token: string): void {
  if (token.length < 32 || token.includes("\n") || token.includes("\r"))
    throw new Error("invalid_dsh_service_token");
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
