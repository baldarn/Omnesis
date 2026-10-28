// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The upstream half of a sync page: read Telegram, write the archive
 * (`docs/telegram-source.md` §7.2–§7.5).
 *
 * One `run()` spends a bounded budget of requests, paced at least
 * `HISTORY_MIN_INTERVAL_MS` apart (across pages too), on, in order:
 *
 * 1. **Enumeration** — the dialog list, when it is due: never read, older
 *    than `FULL_RECONCILE_INTERVAL_H`, or asked for by an account-wide gap.
 *    It records every chat (archived ones included), and queues a forward
 *    re-page for any chat whose top message is past what the archive holds.
 * 2. **Forward re-pages** — ids above a chat's gap floor, newest first, until
 *    the floor is reached. This is what recovers messages lost in a gap,
 *    because mtcute does not report `differenceTooLong` at all.
 * 3. **The backward walk** — each chat not yet walked, most recently active
 *    first, newest page to oldest, until a short page or the data cutoff.
 * 4. **Presence checks** — after a gap, the recent ids of each chat involved
 *    are asked for again: one Telegram no longer returns was deleted, and a
 *    newer edit date is an edit the gap swallowed.
 *
 * Every page commits with the checkpoint it advances, so the walk resumes at
 * any request boundary. A flood wait stops the run and is recorded; later
 * pages make no upstream call until it passes, but still drain. Only a
 * revoked session throws.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import { extractMessage } from "./message-extractor.js";
import {
  boxOf,
  type ChatProgress,
  type HistoryPageWrite,
  type TelegramArchive,
} from "./message-store.js";
import {
  FULL_RECONCILE_INTERVAL_H,
  HISTORY_MIN_INTERVAL_MS,
  HISTORY_PAGE_SIZE,
  PRESENCE_BATCH_SIZE,
  RECONCILE_WINDOW_DAYS,
  WALK_DEADLINE_MARGIN_MS,
  WALK_REQUESTS_PER_PAGE,
} from "./limits.js";
import {
  TelegramError,
  type TelegramAdapter,
  type TgChat,
  type TgDialog,
  type TgMessage,
  type TgUser,
} from "./client/types.js";
import type { StoredChat, StoredMessage } from "./types.js";

const log = createLogger("source:telegram-messages").child("walker");

/** Which chats the operator wants archived. */
export interface ChatPolicy {
  includeChannels: boolean;
  /** Marked chat ids or `@usernames`. */
  excludedChats: readonly string[];
}

/** Whether a chat is archived under `policy`. */
export function isChatIncluded(
  chat: Pick<StoredChat, "kind" | "username"> & { chatId?: number; id?: number },
  policy: ChatPolicy,
): boolean {
  if (chat.kind === "channel" && !policy.includeChannels) return false;
  const id = String(chat.chatId ?? chat.id);
  const username = chat.username?.toLowerCase();
  return !policy.excludedChats.some((entry) => {
    const e = entry.trim();
    if (e.startsWith("@")) return !!username && e.slice(1).toLowerCase() === username;
    return e === id;
  });
}

export interface WalkerClock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realClock: WalkerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export interface WalkLimits {
  requestsPerPage: number;
  minIntervalMs: number;
  pageSize: number;
  deadlineMarginMs: number;
}

const DEFAULT_WALK_LIMITS: WalkLimits = {
  requestsPerPage: WALK_REQUESTS_PER_PAGE,
  minIntervalMs: HISTORY_MIN_INTERVAL_MS,
  pageSize: HISTORY_PAGE_SIZE,
  deadlineMarginMs: WALK_DEADLINE_MARGIN_MS,
};

/**
 * Why a run stopped. Only `budget` means "more work, call again now"; the
 * others either finished or cannot progress until something changes.
 */
type WalkStop = "complete" | "budget" | "deadline" | "flood" | "aborted" | "network";

export interface WalkOutcome {
  stop: WalkStop;
  requests: number;
}

export interface HistoryWalkerDeps {
  adapter: TelegramAdapter;
  archive: TelegramArchive;
  policy: ChatPolicy;
  /** Unix seconds; older messages are neither walked nor stored. */
  cutoffTs?: number;
  clock?: WalkerClock;
  limits?: Partial<WalkLimits>;
}

class Stop extends Error {
  constructor(readonly reason: Exclude<WalkStop, "complete">) {
    super(reason);
  }
}

/** A chat Telegram refused; the run moves on to the next one. */
class ChatRefused extends Error {}

export class HistoryWalker {
  private readonly adapter: TelegramAdapter;
  private readonly archive: TelegramArchive;
  private readonly clock: WalkerClock;
  private readonly limits: WalkLimits;
  private readonly policy: ChatPolicy;
  private readonly cutoffTs: number | undefined;
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(deps: HistoryWalkerDeps) {
    this.adapter = deps.adapter;
    this.archive = deps.archive;
    this.clock = deps.clock ?? realClock;
    this.limits = { ...DEFAULT_WALK_LIMITS, ...deps.limits };
    this.policy = deps.policy;
    this.cutoffTs = deps.cutoffTs;
  }

  /** Spend one page's budget. Throws only a revoked-session `TelegramError`. */
  async run(budget: { deadline?: number; signal?: AbortSignal } = {}): Promise<WalkOutcome> {
    const ctx = { requests: 0, budget };
    if (this.archive.floodUntil() !== undefined) return { stop: "flood", requests: 0 };
    try {
      if (this.archive.enumerationDue(FULL_RECONCILE_INTERVAL_H * 3600)) await this.enumerate(ctx);
      for (const chat of this.included((c) => c.reconcileFromId !== undefined)) {
        await this.perChat(chat, () => this.forward(ctx, chat.chatId));
      }
      for (const chat of this.included(
        (c) => c.walkState === "pending" || c.walkState === "walking",
      )) {
        await this.perChat(chat, () => this.walk(ctx, chat.chatId));
      }
      for (const chat of this.included(
        (c) =>
          (c.walkState === "walking" || c.walkState === "done") &&
          c.oldestFetchedId !== undefined &&
          c.lastPresenceCheckAt === undefined,
      )) {
        await this.perChat(chat, () => this.presence(ctx, chat));
      }
      return { stop: "complete", requests: ctx.requests };
    } catch (err) {
      if (err instanceof Stop) return { stop: err.reason, requests: ctx.requests };
      throw err;
    }
  }

  private included(filter: (chat: ChatProgress) => boolean): ChatProgress[] {
    return this.archive
      .listChats()
      .filter((c) => c.walkState !== "excluded" && c.walkState !== "failed" && filter(c));
  }

  private async perChat(chat: ChatProgress, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (!(err instanceof ChatRefused)) throw err;
      log.warn(`Telegram refused chat ${chat.chatId}; retrying at the next full reconcile`);
      this.archive.markChatFailed(chat.chatId);
    }
  }

  private async enumerate(ctx: RunContext): Promise<void> {
    const dialogs = await this.listDialogs(ctx);
    this.archive.recordDialogs(dialogs, (chat: TgChat) => isChatIncluded(chat, this.policy));
    log.info(`Listed ${dialogs.length} Telegram dialogs`);
  }

  private async listDialogs(ctx: RunContext): Promise<TgDialog[]> {
    try {
      return await this.dialogsRequest(ctx);
    } catch (err) {
      if (!(err instanceof ChatRefused)) throw err;
      log.warn(`Listing Telegram dialogs failed: ${err.message}`);
      throw new Stop("network");
    }
  }

  private dialogsRequest(ctx: RunContext): Promise<TgDialog[]> {
    return this.request(ctx, async () => {
      const out: TgDialog[] = [];
      for await (const d of this.adapter.iterDialogs({
        archived: "keep",
        signal: ctx.budget.signal,
      })) {
        out.push(d);
      }
      return out;
    });
  }

  private async walk(ctx: RunContext, chatId: number): Promise<void> {
    for (;;) {
      const chat = this.archive.getChat(chatId);
      if (!chat || (chat.walkState !== "pending" && chat.walkState !== "walking")) return;
      const page = await this.request(ctx, () =>
        this.adapter.getHistory(chatId, {
          offsetId: chat.oldestFetchedId ?? 0,
          limit: this.limits.pageSize,
          signal: ctx.budget.signal,
        }),
      );
      const write = this.pageWrite(page);
      const reachedCutoff =
        this.cutoffTs !== undefined && page.messages.some((m) => m.date < this.cutoffTs!);
      // mtcute drops `messageEmpty` entries, so a short page is not the end:
      // only an empty one is.
      write.done = page.messages.length === 0 || reachedCutoff;
      this.archive.commitWalkPage(chatId, write);
    }
  }

  private async forward(ctx: RunContext, chatId: number): Promise<void> {
    for (;;) {
      const chat = this.archive.getChat(chatId);
      if (!chat || chat.reconcileFromId === undefined) return;
      const page = await this.request(ctx, () =>
        this.adapter.getHistory(chatId, {
          offsetId: chat.reconcileOffsetId ?? 0,
          minId: chat.reconcileFromId,
          limit: this.limits.pageSize,
          signal: ctx.budget.signal,
        }),
      );
      const write = this.pageWrite(page);
      write.done = page.messages.length === 0;
      this.archive.commitForwardPage(chatId, write);
      if (page.messages.length > 0) {
        log.info(`Recovered ${page.messages.length} Telegram messages after a gap in ${chatId}`);
      }
    }
  }

  private async presence(ctx: RunContext, start: ChatProgress): Promise<void> {
    const since = Math.floor(this.clock.now() / 1000) - RECONCILE_WINDOW_DAYS * 86_400;
    const box = boxOf(start);
    for (;;) {
      const chat = this.archive.getChat(start.chatId);
      if (!chat || chat.lastPresenceCheckAt !== undefined) return;
      const ids = this.archive.presenceBatch(
        chat.chatId,
        since,
        chat.presenceAfterId ?? 0,
        PRESENCE_BATCH_SIZE,
      );
      if (ids.length === 0) {
        this.archive.commitPresence(chat.chatId, {
          missingIds: [],
          current: [],
          users: [],
          nextAfterId: null,
        });
        return;
      }
      const found = await this.request(ctx, () =>
        box === "common"
          ? this.adapter.getMessagesCommon(ids)
          : this.adapter.getMessages(chat.chatId, ids),
      );
      const missingIds = ids.filter((_, i) => !found[i]);
      const current = found
        .filter((m): m is TgMessage => !!m && m.chatId === chat.chatId)
        .map(extractMessage)
        .filter((m): m is StoredMessage => m !== null);
      this.archive.commitPresence(chat.chatId, {
        missingIds,
        current,
        users: [],
        nextAfterId: ids.length === PRESENCE_BATCH_SIZE ? ids[ids.length - 1]! : null,
      });
      if (missingIds.length > 0) {
        log.info(
          `Presence check found ${missingIds.length} deleted Telegram messages in ${chat.chatId}`,
        );
      }
    }
  }

  /** What of a page the archive keeps: within the cutoff, through the extractor. */
  private pageWrite(page: { messages: TgMessage[]; users: TgUser[] }): HistoryPageWrite {
    const cutoff = this.cutoffTs;
    return {
      messages: page.messages
        .filter((m) => cutoff === undefined || m.date >= cutoff)
        .map(extractMessage)
        .filter((m): m is StoredMessage => m !== null),
      users: page.users,
      rawIds: page.messages.map((m) => m.id),
      done: false,
    };
  }

  /**
   * One upstream request inside the page's budget, paced from the previous
   * one. Classifies the failures: a flood wait is recorded and stops the run,
   * a network failure stops it, a refusal skips the chat, and a revoked
   * session propagates.
   */
  private async request<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
    const { budget } = ctx;
    if (budget.signal?.aborted) throw new Stop("aborted");
    if (ctx.requests >= this.limits.requestsPerPage) throw new Stop("budget");
    if (
      budget.deadline !== undefined &&
      budget.deadline - this.clock.now() < this.limits.deadlineMarginMs
    ) {
      throw new Stop("deadline");
    }
    const wait = this.lastRequestAt + this.limits.minIntervalMs - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, budget.signal);
    if (budget.signal?.aborted) throw new Stop("aborted");
    ctx.requests++;
    this.lastRequestAt = this.clock.now();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TelegramError)) {
        log.warn(`Telegram request failed: ${toErrorMessage(err)}`);
        throw new Stop("network");
      }
      switch (err.code) {
        case "revoked":
          throw err;
        case "flood-wait": {
          const seconds = err.detail?.seconds ?? 60;
          this.archive.recordFloodWait(seconds);
          log.warn(`Telegram asked to wait ${seconds}s; the walk pauses until then`);
          throw new Stop("flood");
        }
        case "network":
          throw new Stop("network");
        case "cancelled":
          throw new Stop("aborted");
        case "forbidden":
        case "not-found":
        case "unknown":
        case "file-reference-expired":
          throw new ChatRefused(err.message);
      }
    }
  }
}

interface RunContext {
  requests: number;
  budget: { deadline?: number; signal?: AbortSignal };
}
