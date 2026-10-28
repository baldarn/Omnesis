// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invented people and helpers the Telegram tests share. Every name, number and
 * id here is fictional: phone numbers sit in NANP's 555-0100–0199 fiction range
 * (inside a real area code, so they normalise to E.164), user ids are made up,
 * and handles are `*_example`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProviderCredentials } from "@omnesis/core";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { TELEGRAM_FILE_KEY } from "../credentials-spec.js";
import type { TgUser } from "../client/types.js";
import type {
  AskableChallenge,
  AuthAnswer,
  AuthChallengeKind,
  AuthSession,
  ShowableChallenge,
} from "@omnesis/source-sdk";

export const SELF: TgUser = {
  id: 5550100101,
  firstName: "Maya",
  lastName: "Reeves",
  username: "maya_example",
  phone: "12025550101",
  isBot: false,
  isDeleted: false,
  isSelf: true,
};

export const OTHER_ACCOUNT: TgUser = {
  id: 5550100102,
  firstName: "Jamie",
  lastName: "Lopez",
  username: "jamie_example",
  phone: "12025550102",
  isBot: false,
  isDeleted: false,
  isSelf: true,
};

export const APP_CREDENTIALS = {
  api_id: "1234567",
  api_hash: "0123456789abcdef0123456789abcdef",
};

export function tempConfigDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `omnesis-telegram-${label}-`));
}

export async function writeAppCredentials(configDir: string): Promise<void> {
  await writeProviderCredentials(TELEGRAM_FILE_KEY, APP_CREDENTIALS, configDir);
}

export interface ScriptedSession {
  session: AuthSession;
  shown: ShowableChallenge[];
  asked: AskableChallenge[];
}

/**
 * An `AuthSession` whose `ask` answers the two-step password challenge from
 * `passwords`, in order.
 */
export function scriptedSession(
  configDir: string,
  opts: { accountId?: string; passwords?: string[]; renders?: AuthChallengeKind[] } = {},
): ScriptedSession {
  const shown: ShowableChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const passwords = [...(opts.passwords ?? [])];
  const renders = new Set(opts.renders ?? ["qr", "wait", "fields"]);
  const session: AuthSession = {
    reason: opts.accountId ? "reauthenticate" : "connect",
    flowId: "flow-telegram-test",
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
    supplied: {},
    host: fakeProviderHost({
      configDir,
      stateDir: join(configDir, "telegram"),
      now: () => new Date(),
    }),
    canShow: (kind) => renders.has(kind),
    show: (challenge) => void shown.push(challenge),
    ask: <C extends AskableChallenge>(challenge: C) => {
      asked.push(challenge);
      return Promise.resolve({ password: passwords.shift() ?? "" } as unknown as AuthAnswer<C>);
    },
  };
  return { session, shown, asked };
}

/** Wait until `predicate` holds, polling on the event loop. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
