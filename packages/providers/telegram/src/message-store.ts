// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramArchive`: the protected local archive of one Telegram account.
 *
 * `<stateDir>/archive.db` holds every archived message, the chats and users
 * they belong to, the per-chat walk checkpoints, the deletion index, the days
 * waiting to be published, and the attachments already emitted
 * (`docs/telegram-source.md` §5.1). The cursor the host persists is only a
 * position in it, so the archive is what makes a lost cursor cheap.
 *
 * This file holds the open, the encryption posture and the schema. The write
 * and drain paths that use the schema arrive with the history walk.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizePhone } from "@omnesis/core";
import { openProtectedDatabase, inspectProtectedStore, type Db } from "./protected-store.js";
import type { LocalStoreProbeResult } from "@omnesis/source-sdk";
import type { TgUser } from "./client/types.js";

export const ARCHIVE_FILE = "archive.db";
export const ARCHIVE_LABEL = "Telegram message archive";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  username TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_forum INTEGER NOT NULL DEFAULT 0,
  walk_state TEXT NOT NULL DEFAULT 'pending',
  oldest_fetched_id INTEGER,
  newest_seen_id INTEGER NOT NULL DEFAULT 0,
  top_at_enumeration INTEGER NOT NULL DEFAULT 0,
  reconcile_from_id INTEGER,
  last_presence_check_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  username TEXT,
  phone_e164 TEXT,
  is_bot INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  box TEXT NOT NULL,
  ts INTEGER NOT NULL,
  edit_ts INTEGER,
  sender_id INTEGER,
  sender_name TEXT,
  outgoing INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply_to_id INTEGER,
  topic_id INTEGER,
  forward_from TEXT,
  grouped_id TEXT,
  service TEXT,
  media_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  transcript TEXT,
  media_state TEXT,
  media_attempts INTEGER NOT NULL DEFAULT 0,
  media_next_attempt INTEGER,
  media_last_error TEXT,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS messages_by_chat_ts ON messages(chat_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_box_id ON messages(box, msg_id);

CREATE TABLE IF NOT EXISTS pending_deletions (
  box TEXT NOT NULL,
  msg_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (box, msg_id)
);

CREATE TABLE IF NOT EXISTS dirty_days (
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  emit_seq INTEGER,
  PRIMARY KEY (chat_id, date)
);
CREATE INDEX IF NOT EXISTS dirty_days_emit_seq ON dirty_days(emit_seq);

CREATE TABLE IF NOT EXISTS emitted_attachments (
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  external_id TEXT NOT NULL,
  emit_seq INTEGER NOT NULL,
  PRIMARY KEY (chat_id, date, external_id)
);

CREATE TABLE IF NOT EXISTS topics (
  chat_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (chat_id, topic_id)
);
`;

export interface ArchiveOptions {
  /** Clock, for `updated_at`. */
  now?: () => number;
}

/** A user as the archive keeps it. */
export interface StoredUser {
  userId: number;
  displayName: string;
  username?: string;
  phoneE164?: string;
  isBot: boolean;
}

export class TelegramArchive {
  readonly storeId: string;
  private closed = false;
  private readonly now: () => number;

  private constructor(
    private readonly db: Db,
    options: ArchiveOptions,
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('store_id', ?)").run(randomUUID());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    this.storeId = this.getMeta("store_id")!;
  }

  /**
   * Open the archive in an account directory. `key` is the `telegram-store`
   * key from `readTelegramStoreKey`, already fail-closed: `null` here means the
   * install keeps provider stores unencrypted. The caller zeroes the key.
   */
  static open(stateDir: string, key: Buffer | null, options: ArchiveOptions = {}): TelegramArchive {
    return new TelegramArchive(
      openProtectedDatabase(join(stateDir, ARCHIVE_FILE), key, "message archive"),
      options,
    );
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  upsertUsers(users: readonly TgUser[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO users (user_id, display_name, username, phone_e164, is_bot, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = excluded.display_name,
         username = excluded.username,
         phone_e164 = COALESCE(excluded.phone_e164, users.phone_e164),
         is_bot = excluded.is_bot,
         updated_at = excluded.updated_at`,
    );
    const now = this.now();
    this.db.transaction(() => {
      for (const u of users) {
        stmt.run(
          u.id,
          displayName(u),
          u.username ?? null,
          this.e164(u.phone),
          u.isBot ? 1 : 0,
          now,
        );
      }
    })();
  }

  getUser(userId: number): StoredUser | undefined {
    const row = this.db
      .prepare(
        "SELECT user_id, display_name, username, phone_e164, is_bot FROM users WHERE user_id = ?",
      )
      .get(userId) as
      | {
          user_id: number;
          display_name: string;
          username: string | null;
          phone_e164: string | null;
          is_bot: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      userId: row.user_id,
      displayName: row.display_name,
      ...(row.username ? { username: row.username } : {}),
      ...(row.phone_e164 ? { phoneE164: row.phone_e164 } : {}),
      isBot: row.is_bot === 1,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Telegram reports international digits without the `+`, so no region is needed. */
  private e164(digits: string | undefined): string | null {
    if (!digits) return null;
    return normalizePhone(`+${digits.replace(/^\+/u, "")}`);
  }
}

/** The name a user goes by: first and last name, else the username, else the id. */
export function displayName(u: Pick<TgUser, "id" | "firstName" | "lastName" | "username">): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || (u.username ? `@${u.username}` : String(u.id));
}

/** The doctor's view of both of an account's local stores. */
export function inspectTelegramStores(
  stateDir: string,
  configDir: string,
): LocalStoreProbeResult[] {
  return [
    inspectProtectedStore(join(stateDir, ARCHIVE_FILE), ARCHIVE_LABEL, configDir),
    inspectProtectedStore(join(stateDir, "mtcute.db"), "Telegram connection cache", configDir),
  ];
}
