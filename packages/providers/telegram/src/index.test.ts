// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { fakeProviderHost, fakeSourceHost } from "@omnesis/source-sdk/testing";
import { telegramCredentialsSpec } from "./credentials-spec.js";
import { writeSessionRecord } from "./session-store.js";
import { SimulatedTelegram } from "./testing/simulated-telegram.js";
import {
  OTHER_ACCOUNT,
  SELF,
  scriptedSession,
  tempConfigDir,
  until,
  writeAppCredentials,
} from "./testing/fixtures.js";
import telegram, { TELEGRAM_SOURCE_ID, buildTelegramProvider } from "./index.js";
import type { TelegramProvider } from "./provider.js";
import type { SourceInstance } from "@omnesis/source-sdk";

describe("the Telegram descriptor", () => {
  const source = telegram.sources[0]!;

  it("is one experimental, exclusive provider with the operator's own app credential", () => {
    expect(telegram.type).toBe("provider");
    expect(telegram.provider).toEqual({ id: "telegram", name: "Telegram" });
    expect(telegram.experimental).toBe(true);
    expect(telegram.multiDevice).toEqual({ mode: "exclusive" });
    expect(telegram.authType).toBe("qr");
    expect(telegram.credentials).toBe(telegramCredentialsSpec);
    expect(telegram.sources.map((s) => s.id)).toEqual([TELEGRAM_SOURCE_ID]);
    expect(source.experimental).toBeUndefined();
    expect(source.contentRetention).toBe("complete");
    expect(source.conversational).toBe(true);
  });

  it("draws a complete, generic icon", () => {
    expect(source.icon).toMatchObject({
      sfSymbol: "paperplane.fill",
      color: expect.stringMatching(/^#[0-9A-F]{6}$/u),
      bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/u),
    });
    expect(source.icon?.url).toBeUndefined();
    const svg = Buffer.from(
      source.icon!.imageDataUri!.replace("data:image/svg+xml;base64,", ""),
      "base64",
    ).toString();
    expect(svg).toMatch(/^<svg /u);
    expect(svg).not.toMatch(/circle/u);
  });

  it("declares the self-identity alias the normalizer will emit", () => {
    expect(source.selfIdentity).toEqual({ aliasPrefix: "telegram-user", accountPattern: "^\\d+$" });
    expect(new RegExp(source.selfIdentity!.accountPattern!, "u").test(String(SELF.id))).toBe(true);
    expect(source.contract?.state?.version).toBe(1);
  });
});

describe("the Telegram provider lifecycle", () => {
  let configDir: string;
  let sim: SimulatedTelegram;
  let definition: ReturnType<typeof buildTelegramProvider>;
  const contexts: TelegramProvider[] = [];

  beforeEach(async () => {
    configDir = tempConfigDir("descriptor");
    await writeAppCredentials(configDir);
    sim = new SimulatedTelegram({ self: SELF });
    sim.addAccount({ self: OTHER_ACCOUNT });
    definition = buildTelegramProvider(() => Promise.resolve(sim.factory));
  });

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await definition.disposeContext!(ctx);
    rmSync(configDir, { recursive: true, force: true });
  });

  async function seed(user: typeof SELF): Promise<void> {
    await writeSessionRecord(
      {
        session: sim.issueSession(user.id),
        userId: String(user.id),
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
        ...(user.phone ? { phone: user.phone } : {}),
        ...(user.username ? { username: user.username } : {}),
      },
      configDir,
    );
  }

  async function context(accountId: string): Promise<TelegramProvider> {
    const stateDir = join(configDir, "telegram", accountId);
    const ctx = await definition.createContext!({
      accountId,
      providerId: ProviderId(`telegram:${accountId}`),
      host: fakeProviderHost({ configDir, stateDir }),
    });
    contexts.push(ctx);
    await ctx.ready();
    return ctx;
  }

  async function instance(accountId: string, ctx: TelegramProvider): Promise<SourceInstance> {
    const stateDir = join(configDir, "telegram", accountId);
    return definition.sources[0]!.create!(
      {
        accountId,
        sourceId: SourceId(`telegram-messages:${accountId}`),
        providerId: ProviderId(`telegram:${accountId}`),
        host: fakeSourceHost({ configDir, stateDir }),
        config: { includeChannels: false, excludedChats: [] },
      } as never,
      ctx,
    );
  }

  it("discovers accounts from their credential records only, described offline", async () => {
    await seed(SELF);
    await seed({ ...OTHER_ACCOUNT, phone: undefined, username: undefined });
    // A directory the host created is not an account.
    mkdirSync(join(configDir, "telegram", "5550100199"), { recursive: true });
    const accounts = await definition.discover!({ configDir });
    expect(accounts).toEqual(
      expect.arrayContaining([
        {
          id: String(SELF.id),
          label: "@maya_example",
          subject: { kind: "phone", value: "+12025550101" },
          aliases: [{ kind: "handle", value: "maya_example" }],
        },
        {
          id: String(OTHER_ACCOUNT.id),
          subject: { kind: "opaque", value: String(OTHER_ACCOUNT.id) },
          aliases: [],
        },
      ]),
    );
    expect(accounts).toHaveLength(2);
    expect(sim.calls).toEqual([]);
  });

  it("connects an account through authenticate", async () => {
    const { session } = scriptedSession(configDir);
    const flow = definition.authenticate!(session);
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    await expect(flow).resolves.toMatchObject({ accounts: [{ accountId: String(SELF.id) }] });
    await expect(definition.discover!({ configDir })).resolves.toHaveLength(1);
  });

  it("returns an empty page once connected, acknowledging only its own archive", async () => {
    await seed(SELF);
    const ctx = await context(String(SELF.id));
    const source = await instance(String(SELF.id), ctx);
    const first = await source.sync(null);
    expect(first).toMatchObject({
      documents: [],
      deletedExternalIds: [],
      hasMore: false,
      cursor: { phase: "bootstrap", committedSeq: 0, storeId: ctx.storeId },
    });
    const same = await source.sync({ phase: "incremental", committedSeq: 7, storeId: ctx.storeId });
    expect(same.cursor).toMatchObject({ committedSeq: 7 });
    const foreign = await source.sync({ phase: "incremental", committedSeq: 7, storeId: "other" });
    expect(foreign.cursor).toMatchObject({ committedSeq: 0, storeId: ctx.storeId });
    await expect(
      source.probeLocalStores!({ signal: new AbortController().signal }),
    ).resolves.toEqual([
      { keyName: "telegram-store", label: "Telegram message archive", state: "plaintext" },
      { keyName: "telegram-store", label: "Telegram connection cache", state: "absent" },
    ]);
  });

  it("parks a revoked account: sync fails as auth and credentialState reads unlinked", async () => {
    await seed(SELF);
    const ctx = await context(String(SELF.id));
    const source = await instance(String(SELF.id), ctx);
    const errors: string[] = [];
    source.onSourceError!((e) => errors.push(e));
    sim.revoke("SESSION_REVOKED");
    const failure = await source.sync(null).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SyncError);
    expect((failure as SyncError).kind).toBe("auth");
    expect(errors).toHaveLength(1);
    await expect(definition.credentialState!(ctx)).resolves.toMatchObject({ status: "unlinked" });
  });

  it("keeps two accounts' state apart", async () => {
    await seed(SELF);
    await seed(OTHER_ACCOUNT);
    const a = await context(String(SELF.id));
    const b = await context(String(OTHER_ACCOUNT.id));
    expect(a.storeId).not.toBe(b.storeId);
    expect(a.getArchive().getUser(OTHER_ACCOUNT.id)).toBeUndefined();
    expect(b.getArchive().getUser(SELF.id)).toBeUndefined();
    sim.revoke("SESSION_REVOKED", SELF.id);
    await expect(a.ensureUsable()).rejects.toMatchObject({ kind: "auth" });
    await expect(b.ensureUsable()).resolves.toBeUndefined();
  });

  it("removes one account's credential, archive and cache on cleanup", async () => {
    await seed(SELF);
    await seed(OTHER_ACCOUNT);
    await definition.cleanupCredentials!(String(SELF.id), { configDir });
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      expect.objectContaining({ id: String(OTHER_ACCOUNT.id) }),
    ]);
  });
});
