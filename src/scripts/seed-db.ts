/**
 * seed-db.ts — Download and decompress a seed database on first deploy.
 *
 * Checks if the database file exists and has content. If not, downloads
 * a gzipped copy from SEED_DB_URL and decompresses it to DATABASE_PATH.
 * Skips entirely on subsequent deploys when the file already exists.
 *
 * Usage: npx tsx src/scripts/seed-db.ts
 *
 * Env vars:
 *   DATABASE_PATH  — where the DB should live (default: ./data/dumont.db)
 *   SEED_DB_URL    — URL to a .gz compressed SQLite database
 */

import { existsSync, statSync, mkdirSync, createWriteStream, unlinkSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? process.env.DUMONT_DB_PATH ?? "./data/dumont.db";
const seedUrl = process.env.SEED_DB_URL;

async function main(): Promise<void> {
  // Check if DB already exists with content
  if (existsSync(dbPath)) {
    const size = statSync(dbPath).size;
    if (size > 0) {
      console.log(`[seed] Database exists at ${dbPath} (${(size / 1e9).toFixed(2)} GB) — skipping download`);
      return;
    }
    console.log(`[seed] Database at ${dbPath} is empty — will download`);
  } else {
    console.log(`[seed] No database at ${dbPath} — will download`);
  }

  if (!seedUrl) {
    console.log("[seed] SEED_DB_URL not set — skipping. Server will create empty DB via migrations.");
    return;
  }

  // Ensure parent directory exists
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const gzPath = dbPath + ".gz";

  // Download
  console.log(`[seed] Downloading from ${seedUrl}...`);
  const response = await fetch(seedUrl, { redirect: "follow" });

  if (!response.ok) {
    console.error(`[seed] Download failed: ${response.status} ${response.statusText}`);
    console.log("[seed] Server will start with empty DB via migrations.");
    return;
  }

  if (!response.body) {
    console.error("[seed] No response body");
    return;
  }

  const contentLength = response.headers.get("content-length");
  const sizeMb = contentLength ? `${(Number(contentLength) / 1e6).toFixed(0)} MB` : "unknown size";
  console.log(`[seed] Downloading ${sizeMb}...`);

  // Stream to disk
  const fileStream = createWriteStream(gzPath);
  const readable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  await pipeline(readable, fileStream);

  const gzSize = statSync(gzPath).size;
  console.log(`[seed] Downloaded ${(gzSize / 1e6).toFixed(0)} MB compressed`);

  // Decompress
  console.log(`[seed] Decompressing to ${dbPath}...`);
  const { createReadStream } = await import("node:fs");
  const gunzip = createGunzip();
  const outStream = createWriteStream(dbPath);
  await pipeline(createReadStream(gzPath), gunzip, outStream);

  const dbSize = statSync(dbPath).size;
  console.log(`[seed] Decompressed to ${(dbSize / 1e9).toFixed(2)} GB`);

  // Clean up compressed file
  unlinkSync(gzPath);
  console.log("[seed] Cleaned up compressed file");
  console.log("[seed] Database ready.");
}

main().catch((err) => {
  console.error("[seed] Error:", err);
  console.log("[seed] Server will attempt to start with empty DB via migrations.");
  // Don't exit(1) — let the server start anyway with an empty DB
});
