// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  ensureStorageKey,
  markStorageEncryptionRequired,
} from "@omnesis/core";
import { TelegramArchive, inspectTelegramStores } from "./message-store.js";
import { readTelegramStoreKey, StoreKeyUnavailableError } from "./protected-store.js";
import { TelegramProvider } from "./provider.js";
import { writeSessionRecord } from "./session-store.js";
import { SimulatedTelegram } from "./testing/simulated-telegram.js";
import { SELF, tempConfigDir, writeAppCredentials } from "./testing/fixtures.js";

const HEADER = "SQLite format 3\0";
const ACCOUNT = String(SELF.id);

function header(path: string): string {
  return readFileSync(path).subarray(0, HEADER.length).toString();
}

describe("TelegramArchive storage", () => {
  let configDir: string;
  let stateDir: string;

  beforeEach(() => {
    configDir = tempConfigDir("archive");
    stateDir = join(configDir, "telegram", ACCOUNT);
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSecretFileKeyCacheForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function mintKey(): Promise<void> {
    await ensureInstallRootKey({ backend: "file", configDir });
    await ensureStorageKey("telegram-store", { backend: "file", configDir });
  }

  function openArchive(): TelegramArchive {
    const key = readTelegramStoreKey(configDir);
    try {
      return TelegramArchive.open(stateDir, key);
    } finally {
      key?.fill(0);
    }
  }

  it("creates every table of the schema and a stable archive identity", () => {
    const archive = openArchive();
    const id = archive.storeId;
    archive.close();
    const raw = new Database(join(stateDir, "archive.db"), { readonly: true });
    try {
      const tables = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((t) => t.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "meta",
          "chats",
          "users",
          "messages",
          "pending_deletions",
          "dirty_days",
          "emitted_attachments",
          "topics",
        ]),
      );
    } finally {
      raw.close();
    }
    const reopened = openArchive();
    expect(reopened.storeId).toBe(id);
    expect(reopened.getMeta("schema_version")).toBe("1");
    reopened.close();
  });

  it("encrypts the archive with the telegram-store key, and only that key opens it", async () => {
    await mintKey();
    const archive = openArchive();
    archive.upsertUsers([SELF]);
    archive.close();

    const path = join(stateDir, "archive.db");
    expect(header(path)).not.toBe(HEADER);
    expect(readFileSync(path).includes(Buffer.from("Maya Reeves"))).toBe(false);
    expect(() => {
      const raw = new Database(path, { readonly: true });
      try {
        raw.prepare("SELECT count(*) FROM users").get();
      } finally {
        raw.close();
      }
    }).toThrow();

    const reopened = openArchive();
    expect(reopened.getUser(SELF.id)?.displayName).toBe("Maya Reeves");
    reopened.close();
    expect(inspectTelegramStores(stateDir, configDir)).toEqual([
      { keyName: "telegram-store", label: "Telegram message archive", state: "encrypted" },
      { keyName: "telegram-store", label: "Telegram connection cache", state: "absent" },
    ]);
  });

  it("migrates a plaintext archive once the key exists, keeping its rows and identity", async () => {
    const plain = openArchive();
    plain.upsertUsers([SELF]);
    const id = plain.storeId;
    plain.close();
    expect(header(join(stateDir, "archive.db"))).toBe(HEADER);
    expect(inspectTelegramStores(stateDir, configDir)[0]?.state).toBe("plaintext");

    await mintKey();
    const archive = openArchive();
    expect(archive.storeId).toBe(id);
    expect(archive.getUser(SELF.id)?.displayName).toBe("Maya Reeves");
    archive.close();
    expect(header(join(stateDir, "archive.db"))).not.toBe(HEADER);
    expect(existsSync(join(stateDir, "archive.db.rekey"))).toBe(false);
  });

  it("refuses to open when encryption is required and the key is missing", async () => {
    await markStorageEncryptionRequired(configDir);
    expect(() => readTelegramStoreKey(configDir)).toThrow(StoreKeyUnavailableError);
    expect(() => readTelegramStoreKey(configDir)).toThrow(/omnesis keyring storage-init/u);
  });

  it("writes neither file when the key is missing, and never builds a client", async () => {
    await writeAppCredentials(configDir);
    const sim = new SimulatedTelegram({ self: SELF });
    await writeSessionRecord(
      {
        session: sim.issueSession(SELF.id),
        userId: ACCOUNT,
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
      },
      configDir,
    );
    await markStorageEncryptionRequired(configDir);
    await expect(
      TelegramProvider.open({ accountId: ACCOUNT, configDir, stateDir, factory: sim.factory }),
    ).rejects.toBeInstanceOf(StoreKeyUnavailableError);
    expect(existsSync(join(stateDir, "archive.db"))).toBe(false);
    expect(existsSync(join(stateDir, "mtcute.db"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual(["credentials.json"]);
    expect(sim.devices).toEqual([]);
  });

  it("quarantines a corrupt archive and starts an empty one", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "archive.db"), Buffer.alloc(8192, 7));
    const archive = openArchive();
    expect(archive.storeId).toMatch(/^[0-9a-f-]{36}$/u);
    archive.close();
    expect(readdirSync(stateDir).some((f) => f.startsWith("archive.db.corrupt-"))).toBe(true);
  });
});
