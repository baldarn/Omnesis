// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An in-memory Telegram for tests and the synthetic twin.
 *
 * `SimulatedTelegram` holds an invented account and corpus and hands out
 * adapters (`factory`) that implement the same `TelegramAdapter` and
 * `TelegramAuthAdapter` the mtcute adapter does, deterministically. A test
 * scripts the server side — scan the code, require a password, end a session,
 * fail the next call — and reads `calls` to assert what the provider asked for.
 *
 * Waiting is done with `setTimeout`, so fake timers drive it. Every name,
 * number and id in a corpus built here must be invented.
 *
 * Phase 1 covers sign-in, connect, revocation and the connection lifecycle;
 * the history and update scripting (`pushNew`, `dropUpdates`, `setMedia`, …)
 * arrive with the history walk.
 */

import {
  TelegramError,
  type AdapterFactory,
  type AppCredentials,
  type DeviceInfo,
  type RevocationReason,
  type TelegramAdapter,
  type TelegramAuthAdapter,
  type TgChat,
  type TgDialog,
  type TgMediaRef,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "../client/types.js";

/** How long a simulated login code lives before it rotates on its own. */
export const SIMULATED_QR_TTL_MS = 30_000;

export interface SimulatedCorpus {
  self: TgUser;
  users?: TgUser[];
  chats?: Array<{ chat: TgChat; messages: TgMessage[] }>;
}

export interface SimulatedCall {
  method: string;
  args?: unknown;
}

type Waiter = { resolve: () => void; reject: (err: unknown) => void };

export class SimulatedTelegram {
  /** Every request any adapter made, in order. */
  readonly calls: SimulatedCall[] = [];
  /** Live adapters currently holding an open connection. */
  activeConnections = 0;
  /** Device metadata each adapter was built with. */
  readonly devices: DeviceInfo[] = [];
  /** App credentials each adapter was built with. */
  readonly appCredentials: AppCredentials[] = [];

  private readonly accounts = new Map<number, SimulatedCorpus>();
  private readonly sessions = new Map<string, { userId: number; revoked?: RevocationReason }>();
  private readonly failures = new Map<string, TelegramError[]>();
  private readonly liveAdapters = new Set<SimulatedTelegramAdapter>();
  private sessionCounter = 0;
  private password: string | undefined;
  private qrCounter = 0;
  private pendingLogin: { waiter: Waiter; scannedBy?: number; rotate: () => void } | undefined;

  constructor(corpus: SimulatedCorpus) {
    this.addAccount(corpus);
  }

  /** Another account a code can be scanned with (e.g. the wrong one). */
  addAccount(corpus: SimulatedCorpus): void {
    this.accounts.set(corpus.self.id, corpus);
  }

  readonly factory: AdapterFactory = {
    live: (creds, storage, device) => {
      this.appCredentials.push(creds);
      this.devices.push(device);
      const adapter = new SimulatedTelegramAdapter(this, storage);
      this.liveAdapters.add(adapter);
      return adapter;
    },
    auth: (creds, device) => {
      this.appCredentials.push(creds);
      this.devices.push(device);
      return new SimulatedAuthAdapter(this);
    },
  };

  /** Mint a valid session string for an account, as a completed sign-in would. */
  issueSession(userId: number): string {
    const session = `sim-session:${userId}:${++this.sessionCounter}`;
    this.sessions.set(session, { userId });
    return session;
  }

  /** Whether a session is still valid. */
  sessionIsActive(session: string): boolean {
    const s = this.sessions.get(session);
    return !!s && !s.revoked;
  }

  // ── Server-side scripting ───────────────────────────────────────────

  /** Require this two-step password on the next sign-in. */
  requirePassword(password: string): void {
    this.password = password;
  }

  /** The login code controls of the sign-in in progress. */
  readonly qr = {
    /** Expire the current code now, so the client receives a fresh one. */
    rotate: (): void => this.pendingLogin?.rotate(),
    /** Scan the current code with this account. */
    scan: (userId: number): void => {
      const pending = this.pendingLogin;
      if (!pending) throw new Error("No sign-in is waiting for a scan");
      pending.scannedBy = userId;
      pending.waiter.resolve();
    },
  };

  /**
   * End every session of an account, as terminating it from a phone does.
   * The next request on it fails with `reason`.
   */
  revoke(reason: RevocationReason, userId?: number): void {
    for (const s of this.sessions.values()) {
      if (userId === undefined || s.userId === userId) s.revoked = reason;
    }
  }

  /** End one session, as `auth.logOut` does. */
  endSession(session: string): void {
    const s = this.sessions.get(session);
    if (s) s.revoked = "AUTH_KEY_UNREGISTERED";
  }

  /** Make the next call of `method` fail with `error`. */
  failNext(method: string, error: TelegramError): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  /** Make the next call of `method` fail with a flood wait. */
  floodWait(method: string, seconds: number): void {
    this.failNext(
      method,
      new TelegramError("flood-wait", `FLOOD_WAIT_${seconds}`, { seconds, rpc: "FLOOD_WAIT_%d" }),
    );
  }

  /** Deliver an update to every live adapter. */
  emit(update: TgUpdate): void {
    for (const adapter of this.liveAdapters) adapter.deliver(update);
  }

  // ── Internals the adapters use ──────────────────────────────────────

  /** @internal */
  record(method: string, args?: unknown): void {
    this.calls.push(args === undefined ? { method } : { method, args });
    const queued = this.failures.get(method);
    const failure = queued?.shift();
    if (failure) throw failure;
  }

  /** @internal Throws a revoked error when the session no longer works. */
  authorize(session: string): number {
    const s = this.sessions.get(session);
    if (!s) {
      throw new TelegramError("revoked", "AUTH_KEY_UNREGISTERED", {
        reason: "AUTH_KEY_UNREGISTERED",
        rpc: "AUTH_KEY_UNREGISTERED",
      });
    }
    if (s.revoked) {
      throw new TelegramError("revoked", s.revoked, { reason: s.revoked, rpc: s.revoked });
    }
    return s.userId;
  }

  /** @internal */
  account(userId: number): SimulatedCorpus {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No simulated account ${userId}`);
    return account;
  }

  /** @internal */
  forget(adapter: SimulatedTelegramAdapter): void {
    this.liveAdapters.delete(adapter);
  }

  /** @internal Run one QR sign-in to completion. */
  async signIn(opts: Parameters<TelegramAuthAdapter["signInQr"]>[0]): Promise<{
    self: TgUser;
    session: string;
  }> {
    let scannedBy: number | undefined;
    while (scannedBy === undefined) {
      opts.signal.throwIfAborted();
      const token = `tg://login?token=sim-${++this.qrCounter}`;
      const expires = new Date(Date.now() + SIMULATED_QR_TTL_MS);
      opts.onQr(token, expires);
      scannedBy = await new Promise<number | undefined>((resolve, reject) => {
        const finish = (value: number | undefined) => {
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", onAbort);
          this.pendingLogin = undefined;
          resolve(value);
        };
        const onAbort = () => {
          clearTimeout(timer);
          this.pendingLogin = undefined;
          reject(new TelegramError("cancelled", "Sign-in aborted"));
        };
        const timer = setTimeout(() => finish(undefined), SIMULATED_QR_TTL_MS);
        const login = {
          waiter: { resolve: () => finish(login.scannedBy), reject },
          rotate: () => finish(undefined),
          scannedBy: undefined as number | undefined,
        };
        this.pendingLogin = login;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    opts.onScanned?.();
    if (this.password !== undefined) {
      while ((await opts.password()) !== this.password) {
        this.record("checkPassword");
        await opts.onInvalidPassword();
      }
      this.record("checkPassword");
    }
    const self = this.account(scannedBy).self;
    return { self, session: this.issueSession(self.id) };
  }
}

export class SimulatedTelegramAdapter implements TelegramAdapter {
  private session: string | undefined;
  private connected = false;
  private suspended = false;
  private closed = false;
  private revokedEmitted = false;
  private readonly handlers = new Set<(u: TgUpdate) => void>();

  constructor(
    private readonly server: SimulatedTelegram,
    /** What the provider handed over, for assertions. */
    readonly storage: { dir: string; key: Buffer | null },
  ) {}

  async connect(opts: { session: string; signal?: AbortSignal }): Promise<TgUser> {
    if (this.closed) throw new TelegramError("cancelled", "closed");
    if (this.connected) throw new Error("Simulated adapter connected twice");
    const userId = await this.request("connect", () => {
      opts.signal?.throwIfAborted();
      return this.server.authorize(opts.session);
    });
    this.session = opts.session;
    this.connected = true;
    this.server.activeConnections++;
    return { ...this.server.account(userId).self, isSelf: true };
  }

  exportSession(): Promise<string> {
    return this.request("exportSession", () => {
      if (!this.session) throw new TelegramError("unknown", "Not connected");
      return this.session;
    });
  }

  async checkAuthorization(): Promise<void> {
    await this.request("checkAuthorization", () => this.authorizeCurrent());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.server.record("close");
    this.closed = true;
    this.disconnect();
    this.handlers.clear();
    this.server.forget(this);
  }

  async suspend(): Promise<void> {
    if (this.closed || this.suspended) return;
    this.server.record("suspend");
    this.suspended = true;
    this.disconnect();
  }

  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    this.server.record("resume");
    this.suspended = false;
    if (!this.session || this.connected) return;
    this.connected = true;
    this.server.activeConnections++;
  }

  onUpdate(handler: (u: TgUpdate) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async *iterDialogs(): AsyncIterable<TgDialog> {
    const userId = await this.request("iterDialogs", () => this.authorizeCurrent());
    for (const { chat, messages } of this.server.account(userId).chats ?? []) {
      const last = messages.reduce<TgMessage | undefined>(
        (a, m) => (!a || m.id > a.id ? m : a),
        undefined,
      );
      yield { chat, lastMessageId: last?.id ?? 0, lastMessageDate: last?.date ?? 0 };
    }
  }

  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; minId?: number },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }> {
    return this.request(
      "getHistory",
      () => {
        const corpus = this.server.account(this.authorizeCurrent());
        const chat = corpus.chats?.find((c) => c.chat.id === chatId);
        const messages = (chat?.messages ?? [])
          .filter((m) => (opts.offsetId === 0 || m.id < opts.offsetId) && m.id > (opts.minId ?? 0))
          .sort((a, b) => b.id - a.id)
          .slice(0, opts.limit);
        const ids = new Set(messages.map((m) => m.senderId));
        return { messages, users: (corpus.users ?? []).filter((u) => ids.has(u.id)) };
      },
      { chatId, ...opts },
    );
  }

  getMessages(chatId: number, ids: number[]): Promise<(TgMessage | null)[]> {
    return this.request(
      "getMessages",
      () => {
        const chat = this.server
          .account(this.authorizeCurrent())
          .chats?.find((c) => c.chat.id === chatId);
        return ids.map((id) => chat?.messages.find((m) => m.id === id) ?? null);
      },
      { chatId, ids },
    );
  }

  getMessagesCommon(ids: number[]): Promise<(TgMessage | null)[]> {
    return this.request(
      "getMessagesCommon",
      () => {
        const chats = this.server.account(this.authorizeCurrent()).chats ?? [];
        const common = chats.flatMap((c) => c.messages).filter((m) => m.box === "common");
        return ids.map((id) => common.find((m) => m.id === id) ?? null);
      },
      { ids },
    );
  }

  download(_media: TgMediaRef): Promise<Uint8Array> {
    return this.request("download", () => {
      this.authorizeCurrent();
      throw new TelegramError("not-found", "No simulated media");
    });
  }

  async *iterForumTopics(): AsyncIterable<{ id: number; title: string }> {
    await this.request("iterForumTopics", () => this.authorizeCurrent());
    // No simulated forums yet.
    yield* [];
  }

  /** @internal */
  deliver(update: TgUpdate): void {
    if (!this.connected) return;
    for (const handler of this.handlers) handler(update);
  }

  private disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.server.activeConnections--;
  }

  private authorizeCurrent(): number {
    if (!this.session) throw new TelegramError("unknown", "Not connected");
    if (!this.connected) throw new TelegramError("network", "Disconnected");
    return this.server.authorize(this.session);
  }

  /** One request, asynchronously, with revocation announced like the real adapter. */
  private request<T>(method: string, fn: () => T, args?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          this.server.record(method, args);
          resolve(fn());
        } catch (err) {
          if (err instanceof TelegramError && err.code === "revoked" && !this.revokedEmitted) {
            this.revokedEmitted = true;
            const reason = err.detail?.reason ?? "AUTH_KEY_UNREGISTERED";
            for (const handler of this.handlers) handler({ kind: "revoked", reason });
          }
          reject(err);
        }
      }, 0);
    });
  }
}

class SimulatedAuthAdapter implements TelegramAuthAdapter {
  private session: string | undefined;

  constructor(private readonly server: SimulatedTelegram) {}

  async signInQr(opts: Parameters<TelegramAuthAdapter["signInQr"]>[0]): Promise<{
    self: TgUser;
    session: string;
  }> {
    this.server.record("signInQr");
    const result = await this.server.signIn(opts);
    this.session = result.session;
    return result;
  }

  async logOut(): Promise<void> {
    this.server.record("logOut");
    if (this.session) this.server.endSession(this.session);
  }

  async close(): Promise<void> {
    this.server.record("authClose");
  }
}
