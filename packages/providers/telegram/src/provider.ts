// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramProvider`: one connected account's live context.
 *
 * It owns the account's archive and its live client, connects from the stored
 * session string (no sign-in on restart), and routes the client's updates. Its
 * one hard job is noticing that Telegram ended the session: the updates loop
 * stops silently on a revoked key, so every request goes through a check that
 * recognises the revocation errors, and each sync asks once. A revocation
 * rewrites the credential without its key, stops the client, reports the
 * failure to the host, and makes every later sync an auth error until the
 * operator signs in again.
 *
 * Live updates are archived synchronously inside the update handler
 * (`docs/telegram-source.md` §7.3), before mtcute saves its update state, and
 * each change wakes the host for a sync. A gap the client reports, or an
 * outage long enough to have lost updates, queues a reconcile for the walker.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import { SyncError, type SyncRemediation } from "@omnesis/types";
import { loadAppCredentials } from "./credentials-spec.js";
import { telegramDeviceInfo } from "./device.js";
import { CONNECT_TIMEOUT_MS, GAP_SUSPECT_OUTAGE_S } from "./limits.js";
import { extractMessage } from "./message-extractor.js";
import { isChatIncluded, type ChatPolicy, type TakeoutHolder } from "./history-walker.js";
import { TelegramArchive, type StoredUser } from "./message-store.js";
import { readTelegramStoreKey } from "./protected-store.js";
import {
  markSessionRevoked,
  readSessionRecord,
  recordConnectionState,
  sessionConnectionState,
  writeSessionRecord,
  type TelegramSessionRecord,
} from "./session-store.js";
import {
  TelegramError,
  type AdapterFactory,
  type DeviceInfo,
  type RevocationReason,
  type TelegramAdapter,
  type TgUpdate,
  type TgUser,
} from "./client/types.js";
import type { ConnectionState } from "@omnesis/source-sdk";

const log = createLogger("provider:telegram");

export const REVOKED_REMEDIATION: SyncRemediation = {
  summary: "Telegram ended this connection",
  steps: ["Re-authenticate the Telegram source from Sources and scan the new code."],
  restartRequired: false,
};

export interface TelegramProviderOptions {
  accountId: string;
  /** The collector's config root; the credential and app credential live under it. */
  configDir: string;
  /** `<configDir>/telegram/<accountId>`: the archive and the connection cache. */
  stateDir: string;
  factory: AdapterFactory;
  device?: DeviceInfo;
  now?: () => Date;
}

type ConnectOutcome = { ok: true; self: TgUser } | { ok: false; error: unknown };

export class TelegramProvider {
  readonly accountId: string;
  /**
   * The bootstrap's data export session, once open. Kept here rather than on
   * the source so a config change, which rebuilds the source, reuses it.
   */
  readonly takeout: TakeoutHolder = { takeout: undefined };
  private readonly configDir: string;
  private readonly now: () => Date;
  private connecting: Promise<ConnectOutcome> | undefined;
  private self: TgUser | undefined;
  private revokedReason: RevocationReason | undefined;
  private revocationWrite: Promise<void> = Promise.resolve();
  private disposed = false;
  private suspended = false;
  private readonly errorHandlers = new Set<(error: string) => void>();
  private readonly changeHandlers = new Set<() => void>();
  private readonly unsubscribeUpdates: () => void;
  private chatPolicy: ChatPolicy = { includeChannels: false, excludedChats: [] };
  /** Unix seconds; a live message older than this is not kept. */
  private cutoffTs: number | undefined;
  /** Unix seconds the connection was last seen dropping, while it is down. */
  private offlineSince: number | undefined;

  private constructor(
    options: TelegramProviderOptions,
    private readonly archive: TelegramArchive,
    private readonly adapter: TelegramAdapter,
    private record: TelegramSessionRecord,
  ) {
    this.accountId = options.accountId;
    this.configDir = options.configDir;
    this.now = options.now ?? (() => new Date());
    this.unsubscribeUpdates = adapter.onUpdate((u) => this.onUpdate(u));
  }

  /**
   * Build the account's context and start connecting from its session.
   *
   * Refuses an account with no stored session or a revoked one: there is
   * nothing to connect with, and the remedy is to sign in again. The archive
   * and the cache open under the `telegram-store` key, fail-closed.
   */
  static async open(options: TelegramProviderOptions): Promise<TelegramProvider> {
    const { accountId, configDir, stateDir } = options;
    const creds = await loadAppCredentials(configDir);
    const record = await readSessionRecord(accountId, configDir);
    if (!record) {
      throw new Error(`Telegram account ${accountId} has no stored session; connect it again.`);
    }
    if (!record.session || record.revokedAt) {
      throw new Error(
        `Telegram ended the session for account ${accountId}; re-authenticate it to sign in again.`,
      );
    }
    if (record.apiId !== String(creds.apiId)) {
      log.warn(
        `Telegram account ${accountId} was connected with another api_id; connecting with the current app credential`,
      );
    }
    const key = readTelegramStoreKey(configDir);
    let archive: TelegramArchive | undefined;
    try {
      archive = TelegramArchive.open(stateDir, key);
      // The adapter keeps its own copy for as long as it may reopen the cache.
      const adapter = options.factory.live(
        creds,
        { dir: stateDir, key: key ? Buffer.from(key) : null },
        options.device ?? telegramDeviceInfo(),
      );
      const provider = new TelegramProvider(options, archive, adapter, record);
      // Before the updates loop starts: its catch-up raises newest_seen_id,
      // and the gap floors must sit below whatever the downtime lost.
      provider.checkDowntime();
      provider.connecting = provider.connect();
      return provider;
    } catch (err) {
      archive?.close();
      throw err;
    } finally {
      key?.fill(0);
    }
  }

  /** Resolves once the first connect attempt has finished, successfully or not. */
  async ready(): Promise<void> {
    await this.connecting;
  }

  get isRevoked(): boolean {
    return this.revokedReason !== undefined;
  }

  get storeId(): string {
    return this.archive.storeId;
  }

  getArchive(): TelegramArchive {
    return this.archive;
  }

  /** The live client, for the history walker. */
  getAdapter(): TelegramAdapter {
    return this.adapter;
  }

  /** The account's own user id. */
  get selfId(): number {
    return Number(this.accountId);
  }

  /** The account's own user as the archive keeps it, once connected. */
  selfUser(): StoredUser | undefined {
    return this.archive.getUser(this.selfId);
  }

  /** Which chats live updates may archive; the source sets it from its config. */
  setChatPolicy(policy: ChatPolicy, cutoffTs?: number): void {
    this.chatPolicy = policy;
    this.cutoffTs = cutoffTs;
  }

  /** Called after every archive change a live update made, so the host syncs. */
  onArchiveChange(handler: () => void): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  /**
   * Called at the top of every sync page: fail as auth when the session is
   * gone, as network when the client cannot connect, and otherwise confirm the
   * authorization with one request so a revocation is noticed while idle.
   */
  async ensureUsable(signal?: AbortSignal): Promise<void> {
    if (this.revokedReason) return this.failRevoked();
    if (this.suspended) throw new SyncError("network", "The Telegram connection is paused.");
    let outcome = await withTimeout(this.connecting ?? this.reconnect(), CONNECT_TIMEOUT_MS);
    if (outcome && !outcome.ok && !this.revokedReason) {
      // The first attempt failed for a reason that may have cleared.
      outcome = await withTimeout(this.reconnect(), CONNECT_TIMEOUT_MS);
    }
    if (this.revokedReason) return this.failRevoked();
    if (!outcome) {
      throw new SyncError("network", "Telegram did not connect in time.", { retryAfterMs: 60_000 });
    }
    if (!outcome.ok) throw this.syncErrorFrom(outcome.error);
    try {
      await this.adapter.checkAuthorization({ signal });
    } catch (err) {
      if (this.revokedReason) return this.failRevoked();
      throw this.syncErrorFrom(err);
    }
    if (this.revokedReason) return this.failRevoked();
    this.archive.setMeta("last_online_at", String(this.nowSeconds()));
  }

  private nowSeconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** Fail as auth once the revocation is on disk, so the host reads the same state. */
  private async failRevoked(): Promise<never> {
    await this.revocationWrite;
    throw this.revokedError();
  }

  credentialState(): Promise<ConnectionState> {
    const reason = this.revokedReason;
    if (reason) {
      // What this process saw is the answer, whether or not the rewrite has
      // landed or succeeded: a failed write must not read as connected.
      return this.revocationWrite.then(() =>
        recordConnectionState({ ...this.record, session: "", revokedReason: reason }),
      );
    }
    return sessionConnectionState(this.accountId, this.configDir);
  }

  onSourceError(handler: (error: string) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  async suspend(): Promise<void> {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    await this.adapter.suspend();
  }

  async resume(): Promise<void> {
    if (!this.suspended || this.disposed) return;
    this.suspended = false;
    if (this.revokedReason) return;
    await this.adapter.resume();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeUpdates();
    try {
      // Not waiting for a connect in flight: one stuck on an unreachable
      // network would hold the teardown forever, and closing aborts it.
      await this.adapter.close();
    } finally {
      await this.revocationWrite;
      this.archive.close();
    }
  }

  private async connect(): Promise<ConnectOutcome> {
    try {
      const self = await this.adapter.connect({ session: this.record.session });
      if (this.disposed) {
        return { ok: false, error: new TelegramError("cancelled", "Closed while connecting") };
      }
      if (String(self.id) !== this.accountId) {
        // The session belongs to someone else: whatever produced it, this
        // connection cannot archive this account. Treated as a revocation so
        // the operator is asked to sign in again.
        log.error(`Telegram session for account ${this.accountId} resolved another user`);
        await this.revoke("AUTH_KEY_DUPLICATED");
        return {
          ok: false,
          error: new TelegramError("revoked", "Session belongs to another user"),
        };
      }
      this.self = self;
      this.archive.upsertUsers([self]);
      this.archive.setMeta("last_online_at", String(this.nowSeconds()));
      await this.refreshRecord(self);
      log.info(`Telegram account ${this.accountId} connected`);
      return { ok: true, self };
    } catch (err) {
      if (this.disposed) return { ok: false, error: err };
      if (err instanceof TelegramError && err.code === "revoked") {
        await this.revoke(err.detail?.reason ?? "AUTH_KEY_UNREGISTERED");
      } else {
        log.warn(`Telegram account ${this.accountId} failed to connect: ${toErrorMessage(err)}`);
      }
      return { ok: false, error: err };
    }
  }

  /** Try again after a connect that finished in failure; a pending one is left to run. */
  private reconnect(): Promise<ConnectOutcome> {
    if (this.self) return Promise.resolve({ ok: true, self: this.self });
    this.connecting = this.connect();
    return this.connecting;
  }

  /**
   * Keep the stored session current. mtcute re-exports a different string
   * after the account's home data centre moves, and the phone and username
   * the record carries for `discover()` can change.
   */
  private async refreshRecord(self: TgUser): Promise<void> {
    try {
      const session = await this.adapter.exportSession();
      const next: TelegramSessionRecord = {
        ...this.record,
        session,
        ...(self.phone ? { phone: self.phone } : {}),
        ...(self.username ? { username: self.username } : {}),
      };
      if (
        next.session === this.record.session &&
        next.phone === this.record.phone &&
        next.username === this.record.username
      ) {
        return;
      }
      await writeSessionRecord(next, this.configDir);
      this.record = next;
    } catch (err) {
      log.warn(`Could not refresh the Telegram session record: ${toErrorMessage(err)}`);
    }
  }

  private onUpdate(update: TgUpdate): void {
    try {
      switch (update.kind) {
        case "revoked":
          void this.revoke(update.reason);
          return;
        case "new":
        case "edit": {
          const { chat, message, users } = update;
          const changed = this.archive.storeLive(
            chat,
            users,
            this.cutoffTs !== undefined && message.date < this.cutoffTs
              ? null
              : extractMessage(message),
            { id: message.id, date: message.date },
            isChatIncluded(chat, this.chatPolicy),
          );
          if (changed) this.notifyChange();
          return;
        }
        case "delete":
          if (this.archive.deleteMessages(update.box, update.ids) > 0) this.notifyChange();
          return;
        case "gap":
          if (update.scope === "account") this.archive.requestAccountReconcile();
          else this.archive.requestChannelReconcile(update.scope.channelId);
          log.info(
            `Telegram reported an update gap (${update.scope === "account" ? "account" : "channel"}); reconciling`,
          );
          this.notifyChange();
          return;
        case "connection":
          this.onConnectionState(update.state);
          return;
      }
    } catch (err) {
      // An update handler that throws would restart mtcute's updates loop.
      log.error(`Telegram update handling failed: ${toErrorMessage(err)}`);
    }
  }

  /** Wake the host for work that is not an archive change (media coming due). */
  wake(): void {
    if (!this.disposed) this.notifyChange();
  }

  private notifyChange(): void {
    for (const handler of this.changeHandlers) {
      try {
        handler();
      } catch (err) {
        log.error(`Telegram change handler failed: ${toErrorMessage(err)}`);
      }
    }
  }

  /** An outage long enough to have lost updates asks for an account reconcile. */
  private onConnectionState(state: "offline" | "connecting" | "updating" | "connected"): void {
    // The states of the first connect are covered by checkDowntime().
    if (!this.self) return;
    const now = this.nowSeconds();
    if (state !== "connected") {
      if (this.offlineSince === undefined) {
        this.offlineSince = now;
        // Where every chat stood as the connection dropped: catch-up after
        // the reconnect raises newest_seen_id before "connected" arrives.
        this.archive.markOutageFloors();
      }
      return;
    }
    const since = this.offlineSince;
    this.offlineSince = undefined;
    this.archive.setMeta("last_online_at", String(now));
    if (since !== undefined && now - since > GAP_SUSPECT_OUTAGE_S) {
      log.info(`Telegram was offline for ${now - since}s; reconciling`);
      this.archive.requestAccountReconcile();
      this.notifyChange();
    } else {
      this.archive.clearOutageFloors();
    }
  }

  /** The same for the time this process was not running at all. */
  private checkDowntime(): void {
    const last = Number(this.archive.getMeta("last_online_at") ?? "NaN");
    const now = this.nowSeconds();
    if (Number.isFinite(last) && now - last > GAP_SUSPECT_OUTAGE_S) {
      log.info(`Telegram was last online ${now - last}s ago; reconciling`);
      this.archive.requestAccountReconcile();
    }
  }

  private revoke(reason: RevocationReason): Promise<void> {
    if (this.revokedReason) return this.revocationWrite;
    this.revokedReason = reason;
    log.warn(`Telegram ended the session for account ${this.accountId} (${reason})`);
    this.revocationWrite = (async () => {
      try {
        await markSessionRevoked(this.accountId, reason, this.configDir, this.now());
      } catch (err) {
        log.error(`Could not record the Telegram revocation: ${toErrorMessage(err)}`);
      }
      try {
        await this.adapter.suspend();
      } catch (err) {
        log.debug(`Stopping the revoked Telegram client failed: ${toErrorMessage(err)}`);
      }
    })();
    const message = this.revokedError().message;
    for (const handler of this.errorHandlers) handler(message);
    return this.revocationWrite;
  }

  private revokedError(): SyncError {
    return new SyncError(
      "auth",
      `Telegram ended this connection (${this.revokedReason ?? "revoked"}); sign in again.`,
      { remediation: REVOKED_REMEDIATION },
    );
  }

  private syncErrorFrom(err: unknown): SyncError {
    if (err instanceof SyncError) return err;
    if (err instanceof TelegramError) {
      switch (err.code) {
        case "revoked":
          return this.revokedError();
        case "flood-wait":
          // Telegram counts flood waits against the signed-in account.
          return new SyncError("rate-limit", err.message, {
            retryAfterMs: (err.detail?.seconds ?? 0) * 1000,
            quota: { kind: "account", id: this.accountId },
            cause: err,
          });
        case "network":
        case "cancelled":
          return new SyncError("network", err.message, { cause: err });
        default:
          return new SyncError("unknown", err.message, { cause: err });
      }
    }
    return new SyncError("network", `Telegram connection failed: ${toErrorMessage(err)}`, {
      cause: err,
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
