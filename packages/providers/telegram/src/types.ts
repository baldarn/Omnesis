// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SyncCursor } from "@omnesis/source-sdk";

/**
 * The cursor the host persists for `telegram-messages`: a position in the
 * account's archive, never the corpus. `committedSeq` acknowledges the drain of
 * the archive named by `storeId` (WhatsApp's `emit_seq` protocol); `phase` is
 * for observability.
 */
export interface TelegramSyncCursor extends SyncCursor {
  phase: "bootstrap" | "incremental";
  committedSeq: number;
  storeId?: string;
}
