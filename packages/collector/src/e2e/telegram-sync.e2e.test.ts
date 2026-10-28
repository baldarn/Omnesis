// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-level E2E driving the REAL Telegram provider through the full
 * collector → gateway → indexer → search pipeline.
 *
 * The `telegram-sync` universe ships a `fake-corpus.json`, so the synth
 * Telegram twin runs the real provider, archive, history walk and normalizer
 * over the in-memory `SimulatedTelegram` (the production `AdapterFactory`
 * seam); only mtcute and the QR sign-in are replaced. Asserts, through a
 * spawned gateway:
 *   - the bootstrap walk lands one document per chat per UTC day, archived
 *     chats and Saved Messages included, the opt-in channel left out, and the
 *     day documents are searchable;
 *   - a live edit and a live deletion through the simulated server are
 *     reflected in the stored day document;
 *   - a day whose every message is deleted disappears from the gateway;
 *   - the account's own messages resolve to the cast's self person through
 *     the descriptor's `selfIdentity` alias.
 *
 * The controller is reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { TelegramWrapsRealController } from "@omnesis/provider-telegram-synth";

const SELF_ID = 5550100201;
const MAYA_ID = 5550100202;
const SOURCE_ID = `telegram-messages:${SELF_ID}`;
const MAYA_DAY_1 = `${MAYA_ID}:2026-03-10`;
const MAYA_DAY_2 = `${MAYA_ID}:2026-03-11`;
const CLUB_DAY = "-1001500000001:2026-03-10";
const CREW_DAY = "-4001500001:2026-03-12";
const SAVED_DAY = `${SELF_ID}:2026-03-12`;
const CHANNEL_DAY = "-1001500000002:2026-03-12";

interface DocRow {
  id: string;
  external_id: string;
  content: string;
  metadata: string;
}

async function controller(): Promise<TelegramWrapsRealController> {
  const mod = await import("@omnesis/provider-telegram-synth");
  const ctrl = mod.getTelegramWrapsRealController(SOURCE_ID);
  if (!ctrl) throw new Error(`no wraps-real controller registered for ${SOURCE_ID}`);
  return ctrl;
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("Telegram wraps-real: day documents, live edits and deletions, self identity", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;

  const doc = (externalId: string): DocRow | undefined =>
    db
      .prepare(
        "SELECT id, external_id, content, metadata FROM documents WHERE source_id = ? AND external_id = ?",
      )
      .get(SOURCE_ID, externalId) as DocRow | undefined;

  const selfAliasOwner = (): { is_self: number; name: string } | undefined =>
    db
      .prepare(
        `SELECT p.is_self AS is_self, p.canonical_name AS name FROM person_aliases a
         JOIN people p ON p.id = a.person_id
         WHERE a.alias_type = 'lid' AND a.alias = ? AND p.merged_into IS NULL`,
      )
      .get(`telegram-user:${SELF_ID}`) as { is_self: number; name: string } | undefined;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "telegram-sync",
      extraGatewayConfig: {
        // The install-level operator: the self person the alias attaches to.
        // A self is only created with an identifier, not from a name alone.
        self: { name: "Sarah Mendez", emails: ["sarah.mendez@example.com"] },
      },
    });
    await harness.start();
    db = new Database(harness.getDbPath(), { readonly: true });
    // The self person is bootstrapped from the config after boot, and the
    // collector's self-identity push pairs the account's alias onto it; both
    // must have happened before the first sync, as on a real install.
    await waitFor(
      () => (selfAliasOwner()?.is_self === 1 ? true : undefined),
      "the Telegram self alias on the self person",
      120_000,
    );
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 30_000);

  test("the bootstrap lands one document per chat and day, without the opt-in channel", () => {
    const ids = (
      db.prepare("SELECT external_id FROM documents WHERE source_id = ?").all(SOURCE_ID) as Array<{
        external_id: string;
      }>
    )
      .map((r) => r.external_id)
      .sort();
    expect(ids).toEqual([CLUB_DAY, CREW_DAY, MAYA_DAY_1, MAYA_DAY_2, SAVED_DAY].sort());
    expect(doc(CHANNEL_DAY)).toBeUndefined();

    const maya = doc(MAYA_DAY_1)!;
    expect(maya.content).toContain("**09:00** Maya Reeves: The pelican migration figures");
    expect(maya.content).toContain("**09:05** You: I will rerun the heron counts");
    expect(maya.content).toContain("[Document: entry-form.pdf]");
    const club = doc(CLUB_DAY)!;
    expect(club.content).toContain("> _Jamie Lopez: Long run on Saturday");
    expect(JSON.parse(doc(CREW_DAY)!.metadata)).toMatchObject({
      extra: { chatKind: "group", isArchived: true, isGroup: true },
    });
  });

  test("day documents are searchable", async () => {
    await harness.refreshSearchSnapshot();
    const res = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent("pelican migration")}&limit=50`,
    )) as { results?: Array<{ source_id: string }> };
    expect((res.results ?? []).some((r) => r.source_id === SOURCE_ID)).toBe(true);
  });

  test("a live edit and a live deletion are reflected in the day document", async () => {
    const ctrl = await controller();
    ctrl.server.pushEdit(
      MAYA_ID,
      101,
      "The pelican migration figures are fine after all.",
      Date.parse("2026-03-10T10:00:00Z") / 1000,
    );
    ctrl.server.pushDelete(MAYA_ID, [103]);
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    const maya = await waitFor(() => {
      const row = doc(MAYA_DAY_1);
      return row?.content.includes("fine after all") ? row : undefined;
    }, "the edited Maya day");
    expect(maya.content).toContain("are fine after all. (edited)");
    expect(maya.content).not.toContain("entry-form.pdf");
  });

  test("a day whose messages are all deleted disappears", async () => {
    const ctrl = await controller();
    ctrl.server.pushDelete(MAYA_ID, [107]);
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    await waitFor(() => (doc(MAYA_DAY_2) ? undefined : true), "the emptied day to be removed");
    expect(doc(MAYA_DAY_1)).toBeDefined();
  });

  test("the account's own messages resolve to the self person, not a new one", () => {
    expect(selfAliasOwner()).toEqual({ is_self: 1, name: "Sarah Mendez" });
    const you = db
      .prepare("SELECT COUNT(*) AS c FROM people WHERE canonical_name = 'You'")
      .get() as {
      c: number;
    };
    expect(you.c).toBe(0);
  });
});
