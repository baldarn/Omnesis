// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramMessagesSource`: one `sync()` page (`docs/telegram-source.md` §7.6).
 *
 * A page is: confirm the session; bring the archive in line with the chat
 * exclusions; spend the walk budget upstream (unless a flood wait is active);
 * drain a bounded set of dirty days from the archive; render each as a day
 * document, or tombstone it when nothing in it survives. The cursor is only
 * the drain's acknowledgement (`committedSeq` of the archive `storeId`), so
 * everything the gateway did not accept re-emits.
 *
 * `hasMore` is true only while there is work this page could not finish and
 * the next one can: more dirty days, or a walk that ran out of request budget.
 * A walk stopped by its deadline, a flood wait or the network waits for the
 * next scheduled sync, so a run always terminates.
 */

import { createLogger } from "@omnesis/core";
import {
  HistoryWalker,
  isChatIncluded,
  type ChatPolicy,
  type WalkLimits,
  type WalkerClock,
} from "./history-walker.js";
import { DRAIN_DAY_LIMIT, FLOOD_ISSUE_THRESHOLD_S } from "./limits.js";
import { dayExternalId, normalizeDayChat } from "./normalizer.js";
import { telegramStateSpec } from "./state.js";
import type { HistoryCoverage, SyncOptions, SyncResult, Unsubscribe } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId, SyncIssue } from "@omnesis/types";
import type { TelegramProvider } from "./provider.js";
import type { TelegramSyncCursor } from "./types.js";

const log = createLogger("source:telegram-messages");

export interface TelegramMessagesSourceOptions {
  sourceId: SourceId;
  providerId: ProviderId;
  policy: ChatPolicy;
  /** ISO 8601; nothing older is walked, stored or published. */
  dataCutoff?: string;
  /** For phone numbers written in national form in message text. */
  phoneRegion?: string;
  drainLimit?: number;
  clock?: WalkerClock;
  walkLimits?: Partial<WalkLimits>;
}

export class TelegramMessagesSource {
  private readonly walker: HistoryWalker;
  private readonly cutoffTs: number | undefined;
  private readonly drainLimit: number;

  constructor(
    private readonly provider: TelegramProvider,
    private readonly options: TelegramMessagesSourceOptions,
  ) {
    const cutoff = options.dataCutoff ? Date.parse(options.dataCutoff) : Number.NaN;
    this.cutoffTs = Number.isFinite(cutoff) ? Math.ceil(cutoff / 1000) : undefined;
    this.drainLimit = options.drainLimit ?? DRAIN_DAY_LIMIT;
    provider.setChatPolicy(options.policy, this.cutoffTs);
    this.walker = new HistoryWalker({
      adapter: provider.getAdapter(),
      archive: provider.getArchive(),
      policy: options.policy,
      ...(this.cutoffTs !== undefined ? { cutoffTs: this.cutoffTs } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.walkLimits ? { limits: options.walkLimits } : {}),
    });
  }

  /** Wake the host whenever a live update changed the archive. */
  onPushEvent(callback: () => void): Unsubscribe {
    return this.provider.onArchiveChange(callback);
  }

  /** Re-publish the whole archive and list the dialogs again. */
  onResync(): void {
    const archive = this.provider.getArchive();
    archive.markAllDirty();
    archive.requestFullReconcile();
  }

  async sync(
    cursor: TelegramSyncCursor | null,
    opts?: SyncOptions,
  ): Promise<SyncResult<TelegramSyncCursor>> {
    await this.provider.ensureUsable(opts?.signal);
    const archive = this.provider.getArchive();
    const prior = cursor ? telegramStateSpec.decode(cursor) : null;
    const committedSeq = prior?.storeId === archive.storeId ? prior.committedSeq : 0;

    const { purged, restored } = archive.applyExclusions((chat) =>
      isChatIncluded(chat, this.options.policy),
    );
    if (purged > 0 || restored > 0) {
      log.info(`Telegram chat exclusions changed: ${purged} purged, ${restored} restored`);
    }

    const walk = await this.walker.run({
      ...(opts?.run?.deadline !== undefined ? { deadline: opts.run.deadline } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    const { days, emitSeq, morePending } = archive.drain({
      committedSeq,
      limit: this.drainLimit,
    });
    const self = this.provider.selfUser();
    const documents: DocumentInput[] = [];
    const deletedExternalIds: string[] = [];
    let processed = 0;
    for (const day of days) {
      const id = dayExternalId(day.chatId, day.date);
      const chat = archive.getChat(day.chatId);
      const messages =
        this.cutoffTs === undefined
          ? day.messages
          : day.messages.filter((m) => m.ts >= this.cutoffTs!);
      // No attachments are rendered yet, so every ledgered one is retired.
      const retired = archive.settleAttachments(day.chatId, day.date, [], emitSeq);
      deletedExternalIds.push(...retired);
      if (!chat || day.messages.length === 0) {
        deletedExternalIds.push(id);
        continue;
      }
      // Older than the cutoff: never published, so nothing to remove either.
      if (messages.length === 0) continue;
      const userIds = messages.flatMap((m) => (m.senderId !== undefined ? [m.senderId] : []));
      if (chat.kind === "private") userIds.push(chat.chatId);
      const inDay = new Map(messages.map((m) => [m.msgId, m]));
      const replyIds = messages.flatMap((m) =>
        m.replyToId !== undefined && !inDay.has(m.replyToId) ? [m.replyToId] : [],
      );
      const replies = new Map([...inDay, ...archive.getMessages(day.chatId, replyIds)]);
      documents.push(
        normalizeDayChat({
          chat,
          date: day.date,
          messages,
          users: archive.getUsers(userIds),
          replies,
          self: {
            id: this.provider.selfId,
            ...(self?.phoneE164 ? { phoneE164: self.phoneE164 } : {}),
          },
          providerId: this.options.providerId,
          sourceId: this.options.sourceId,
          ...(this.options.phoneRegion ? { phoneRegion: this.options.phoneRegion } : {}),
        }),
      );
      processed += messages.length;
    }

    const summary = archive.walkSummary();
    const unwalked = summary.pending + summary.walking;
    const floodUntil = archive.floodUntil();
    // Until the dialogs have been listed once, nothing is known to be walked.
    const listed = archive.hasEnumerated();
    const phase = unwalked > 0 || !listed ? "bootstrap" : "incremental";
    const coverage: HistoryCoverage =
      listed && unwalked === 0 && summary.failed === 0
        ? "complete"
        : floodUntil !== undefined || summary.failed > 0
          ? "partial"
          : "unknown";
    const hasMore = morePending || walk.stop === "budget";

    let issues: SyncIssue[] | undefined;
    const floodSeconds = archive.floodSeconds();
    if (floodUntil !== undefined && floodSeconds > FLOOD_ISSUE_THRESHOLD_S) {
      issues = [
        {
          scope: "partition",
          kind: "rate-limit",
          severity: "info",
          count: Math.max(1, unwalked + (summary.reconcilePending ? 1 : 0)),
          message: `Telegram asked Omnesis to slow down; history resumes at ${new Date(floodUntil * 1000).toISOString()}.`,
        },
      ];
    }

    log.info(
      `Telegram sync page: ${documents.length} docs, ${deletedExternalIds.length} removed, walk ${walk.stop} after ${walk.requests} requests (${phase}, coverage ${coverage}, hasMore ${hasMore})`,
    );

    return {
      documents,
      deletedExternalIds,
      ...(issues ? { issues } : {}),
      cursor: { phase, committedSeq: emitSeq, storeId: archive.storeId },
      hasMore,
      progress: { phase, processed, coverage, coverageSubject: "history" },
    };
  }
}
