// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramMessagesSource.sync()` end to end over the simulated server: what
 * a page emits, what it tombstones, and that the page loop settles.
 */

import { afterEach, describe, expect, it } from "vitest";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { SyncError } from "@omnesis/types";
import {
  DAVID,
  JAMIE,
  T0,
  chatOf,
  latestDocs,
  messageIn,
  messageRun,
  privateChatWith,
  syncAll,
  syncRig,
  type SyncRig,
} from "./testing/fixtures.js";
import type { TelegramSyncCursor } from "./types.js";

const JAMIE_CHAT = privateChatWith(JAMIE);
const DAVID_CHAT = privateChatWith(DAVID);
const JAMIE_DAY = `${JAMIE.id}:2026-03-10`;

let rig: SyncRig | undefined;
afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

async function twoChatRig(options = {}): Promise<SyncRig> {
  rig = await syncRig(
    {
      users: [JAMIE, DAVID],
      chats: [
        { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 3, T0) },
        { chat: DAVID_CHAT, messages: messageRun(DAVID_CHAT, DAVID, 4, 2, T0 + 86_400) },
      ],
    },
    options,
  );
  return rig;
}

describe("TelegramMessagesSource.sync", () => {
  it("bootstraps every day, then a cursor sync with nothing new emits nothing", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    expect([...latestDocs(boot.pages).keys()].sort()).toEqual(
      [JAMIE_DAY, `${DAVID.id}:2026-03-11`].sort(),
    );
    expect(boot.cursor).toMatchObject({
      phase: "incremental",
      storeId: r.provider.getArchive().storeId,
    });

    const again = await r.source.sync(boot.cursor);
    expect(again.documents).toEqual([]);
    expect(again.deletedExternalIds).toEqual([]);
    expect(again.hasMore).toBe(false);

    r.sim.pushNew(JAMIE_CHAT.id, { text: "Studio Northstar booked", date: T0 + 3600 });
    const one = await r.source.sync(again.cursor);
    expect(one.documents.map((d) => d.externalId)).toEqual([JAMIE_DAY]);
    expect(one.documents[0]!.content).toContain("Studio Northstar booked");
  });

  it("reflects a live edit and a live delete, and tombstones a day left empty", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.sim.pushEdit(JAMIE_CHAT.id, 2, "Q4 budget review is on Friday", T0 + 7200);
    const edited = await r.source.sync(boot.cursor);
    expect(edited.documents[0]!.content).toContain("Q4 budget review is on Friday (edited)");

    r.sim.pushDelete(JAMIE_CHAT.id, [1]);
    const deleted = await r.source.sync(edited.cursor);
    expect(deleted.documents[0]!.content).not.toContain("Note 1 about");

    r.sim.pushDelete(JAMIE_CHAT.id, [2, 3]);
    const emptied = await r.source.sync(deleted.cursor);
    expect(emptied.documents).toEqual([]);
    expect(emptied.deletedExternalIds).toEqual([JAMIE_DAY]);
  });

  it("tombstones a deleted day's ledgered attachments with it", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    const archive = r.provider.getArchive();
    // As a media render would have ledgered them.
    archive.settleAttachments(JAMIE_CHAT.id, "2026-03-10", [`${JAMIE_DAY}/att/abc`], 1);
    r.sim.pushDelete(JAMIE_CHAT.id, [1, 2, 3]);
    const page = await r.source.sync(boot.cursor);
    expect(page.deletedExternalIds.sort()).toEqual([JAMIE_DAY, `${JAMIE_DAY}/att/abc`].sort());
    const next = await r.source.sync(page.cursor);
    expect(next.deletedExternalIds).toEqual([]);
  });

  it("tombstones every day of a chat that becomes excluded", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.remake({ policy: { includeChannels: false, excludedChats: [String(DAVID.id)] } });
    const page = await r.source.sync(boot.cursor);
    expect(page.deletedExternalIds).toEqual([`${DAVID.id}:2026-03-11`]);
    expect(page.documents).toEqual([]);
  });

  it("re-emits the outstanding backlog for a cursor from another archive", async () => {
    const r = await twoChatRig();
    await syncAll(r.source, null);
    const foreign: TelegramSyncCursor = {
      phase: "incremental",
      committedSeq: 3,
      storeId: "another-archive",
    };
    // Nothing of this archive was acknowledged under that cursor, so the last
    // page's days come back.
    const page = await r.source.sync(foreign);
    expect(page.documents.length).toBeGreaterThan(0);
  });

  it("re-emits everything on a resync", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.source.onResync();
    const again = await syncAll(r.source, boot.cursor);
    expect(latestDocs(again.pages).size).toBe(2);
  });

  it("never publishes a live message older than the data cutoff", async () => {
    const cutoff = new Date((T0 + 86_400) * 1000).toISOString();
    const r = await twoChatRig({ dataCutoff: cutoff });
    const boot = await syncAll(r.source, null);
    expect([...latestDocs(boot.pages).keys()]).toEqual([`${DAVID.id}:2026-03-11`]);
    r.sim.pushNew(JAMIE_CHAT.id, { text: "An old one", date: T0 });
    const page = await r.source.sync(boot.cursor);
    expect(page.documents).toEqual([]);
    expect(page.deletedExternalIds).toEqual([]);
  });

  it("wakes the host for a live change", async () => {
    const r = await twoChatRig();
    let pushes = 0;
    const off = r.source.onPushEvent(() => pushes++);
    r.sim.pushNew(DAVID_CHAT.id, { text: "Marathon entry form sent" });
    expect(pushes).toBe(1);
    off();
    r.sim.pushNew(DAVID_CHAT.id, { text: "And the receipt" });
    expect(pushes).toBe(1);
  });

  it("does not ask for another page when the walk stopped for its deadline", async () => {
    const r = await twoChatRig();
    const page = await r.source.sync(null, {
      run: {
        id: "run-1",
        reason: "scheduled",
        start: "warm",
        page: 0,
        deadline: Date.now() + 1000,
      },
    } as never);
    expect(page.hasMore).toBe(false);
    // Nothing has been listed, so nothing can be claimed about the history.
    expect(page.progress).toMatchObject({ phase: "bootstrap", coverage: "unknown" });
    expect(r.sim.calls.some((c) => c.method === "iterDialogs")).toBe(false);
  });

  it("fails as auth once Telegram ends the session", async () => {
    const r = await twoChatRig();
    const boot = await syncAll(r.source, null);
    r.sim.revoke("SESSION_REVOKED");
    await expect(r.source.sync(boot.cursor)).rejects.toSatisfy(
      (err: unknown) => err instanceof SyncError && err.kind === "auth",
    );
  });

  it("settles against an unchanged upstream", async () => {
    const group = chatOf(-1004000000004, "supergroup", "Riverside Estate residents");
    rig = await syncRig(
      {
        users: [JAMIE, DAVID],
        chats: [
          { chat: JAMIE_CHAT, messages: messageRun(JAMIE_CHAT, JAMIE, 1, 250, T0, 600) },
          {
            chat: group,
            messages: [
              messageIn(group, 1, T0, "Bins go out Tuesday", { senderId: DAVID.id }),
              messageIn(group, 2, T0 + 60, "Thanks", { senderId: JAMIE.id, replyToId: 1 }),
            ],
          },
        ],
      },
      { walkLimits: { requestsPerPage: 2 }, drainLimit: 1 },
    );
    const source = rig.source;
    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      settleSteps: 8,
      primaryKey: () => ["externalId"],
      async step(cursor) {
        const page = await source.sync(cursor as TelegramSyncCursor | null);
        return {
          cursor: page.cursor,
          hasMore: page.hasMore,
          records: page.documents.map((doc) => ({
            table: "documents",
            row: {
              externalId: doc.externalId,
              contentHash: doc.contentHash,
              metadata: doc.metadata,
            },
          })),
        };
      },
    });
  });
});
