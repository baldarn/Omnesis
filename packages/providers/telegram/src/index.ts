// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The experimental Telegram source: the operator's own account, archived over
 * MTProto through their own Telegram API app (`docs/telegram-source.md`).
 *
 * `buildTelegramProvider` takes the client factory, so the tests and the
 * synthetic twin run this exact definition over the simulated adapter; the
 * default export loads the mtcute adapter lazily, which keeps mtcute and its
 * native SQLite out of every process that only reads descriptors.
 */

import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, normalizePhone } from "@omnesis/core";
import {
  config,
  defineProvider,
  emptySync,
  type AccountDescriptor,
  type ProviderDefinition,
  type SyncResult,
} from "@omnesis/source-sdk";
import { safePathSegment } from "@omnesis/types";
import { loginFlow } from "./auth.js";
import { telegramCredentialsSpec } from "./credentials-spec.js";
import { telegramIcon } from "./icons.js";
import { inspectTelegramStores } from "./message-store.js";
import { TelegramProvider } from "./provider.js";
import { listSessionAccounts, readSessionRecord, removeAccount } from "./session-store.js";
import { telegramStateSpec } from "./state.js";
import type { AdapterFactory } from "./client/types.js";
import type { TelegramSyncCursor } from "./types.js";

export { TelegramProvider, REVOKED_REMEDIATION } from "./provider.js";
export { loginFlow } from "./auth.js";
export { telegramCredentialsSpec, loadAppCredentials } from "./credentials-spec.js";
export { TelegramArchive, inspectTelegramStores } from "./message-store.js";
export { telegramStateSpec } from "./state.js";
export { telegramIcon, telegramIconDataUri } from "./icons.js";
export { mapRpcError } from "./client/errors.js";
export { TelegramError, REVOCATION_REASONS } from "./client/types.js";
export type {
  AdapterFactory,
  AppCredentials,
  ChatKind,
  DeviceInfo,
  MessageBox,
  RevocationReason,
  TelegramAdapter,
  TelegramAuthAdapter,
  TelegramErrorCode,
  TgChat,
  TgDialog,
  TgMediaKind,
  TgMediaRef,
  TgMessage,
  TgUpdate,
  TgUser,
} from "./client/types.js";
export type { TelegramSyncCursor } from "./types.js";
export type { TelegramSessionRecord } from "./session-store.js";

export const TELEGRAM_PROVIDER_ID = "telegram";
export const TELEGRAM_SOURCE_ID = "telegram-messages";

/** Where an account's archive and connection cache live when no host says. */
function accountDir(configDir: string, accountId: string): string {
  return join(configDir, TELEGRAM_PROVIDER_ID, safePathSegment(accountId));
}

async function describeAccount(id: string, configDir: string): Promise<AccountDescriptor> {
  // The credential record, never the network. A record that cannot be read
  // right now still names a discoverable account.
  const record = await readSessionRecord(id, configDir).catch(() => null);
  const phone = record?.phone ? normalizePhone(`+${record.phone}`) : null;
  return {
    id,
    ...(record?.username ? { label: `@${record.username}` } : {}),
    subject: phone ? { kind: "phone", value: phone } : { kind: "opaque", value: id },
    aliases: record?.username ? [{ kind: "handle", value: record.username }] : [],
  };
}

export function buildTelegramProvider(
  loadFactory: () => Promise<AdapterFactory>,
): ProviderDefinition<TelegramProvider> {
  return defineProvider<TelegramProvider>({
    provider: { id: TELEGRAM_PROVIDER_ID, name: "Telegram" },
    authType: "qr",
    experimental: true,
    // Two collectors on one session string trip AUTH_KEY_DUPLICATED and
    // would keep two diverging archives.
    multiDevice: { mode: "exclusive" },
    credentials: telegramCredentialsSpec,
    contract: { apiVersion: 2, requires: ["state-envelope", "scoped-host", "typed-config"] },

    async discover(ctx) {
      const configDir = ctx?.configDir ?? DEFAULT_CONFIG_DIR;
      return Promise.all(
        listSessionAccounts(configDir).map((id) => describeAccount(id, configDir)),
      );
    },

    async authenticate(session) {
      return loginFlow(session, { factory: await loadFactory() });
    },

    async cleanupCredentials(accountId, ctx) {
      await removeAccount(accountId, ctx?.configDir ?? DEFAULT_CONFIG_DIR);
    },

    async createContext({ accountId, host }) {
      if (!host) throw new Error("The Telegram source needs a host that provides its directories.");
      return TelegramProvider.open({
        accountId,
        configDir: host.configDir,
        stateDir: host.stateDir,
        factory: await loadFactory(),
      });
    },

    async disposeContext(provider) {
      await provider.dispose();
    },

    credentialState(provider) {
      return provider.credentialState();
    },

    sources: [
      {
        id: TELEGRAM_SOURCE_ID,
        name: "Telegram Messages",
        description: "Sync your Telegram chats through your own Telegram API app (QR sign-in)",
        unitName: "messages",
        conversational: true,
        contentRetention: "complete",
        defaultSyncInterval: "15m",
        ownedWebDomains: ["web.telegram.org"],
        icon: telegramIcon,
        selfIdentity: { aliasPrefix: "telegram-user", accountPattern: "^\\d+$" },
        contract: { state: telegramStateSpec, outputRevision: 1 },
        config: config.object({
          includeChannels: config.boolean({
            label: "Include broadcast channels",
            default: false,
            help: "Off by default. Leave off to archive only your chats and groups.",
          }),
          excludedChats: config.list(config.string({ label: "Chat" }), {
            label: "Excluded chats",
            default: [],
            help: "Chat IDs or @usernames to skip. Already-archived content from them is removed. Leave empty to include every chat.",
          }),
        }),

        create({ host, accountId }, provider) {
          const configDir = host?.configDir;
          const stateDir =
            host?.stateDir ?? (configDir ? accountDir(configDir, accountId) : undefined);
          return Promise.resolve({
            icon: telegramIcon,
            async sync(cursor, opts): Promise<SyncResult<TelegramSyncCursor>> {
              await provider.ensureUsable(opts?.signal);
              // The history walk and the drain arrive with phase 2; until then a
              // connected account has nothing to emit.
              const prior = cursor ? telegramStateSpec.decode(cursor) : null;
              return emptySync<TelegramSyncCursor>({
                phase: "bootstrap",
                committedSeq: prior?.storeId === provider.storeId ? prior.committedSeq : 0,
                storeId: provider.storeId,
              });
            },
            onSourceError: (callback) => provider.onSourceError(callback),
            suspend: () => provider.suspend(),
            resume: () => provider.resume(),
            probeLocalStores: () =>
              Promise.resolve(
                stateDir && configDir ? inspectTelegramStores(stateDir, configDir) : [],
              ),
            async dispose() {
              await provider.dispose();
            },
          });
        },
      },
    ],
  });
}

export default buildTelegramProvider(async () => {
  const { mtcuteAdapterFactory } = await import("./client/mtcute/adapter.js");
  return mtcuteAdapterFactory;
});
