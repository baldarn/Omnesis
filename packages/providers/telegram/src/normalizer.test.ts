// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { extractMessage } from "./message-extractor.js";
import { mediaPlaceholder, normalizeDayChat, type DayRenderInput } from "./normalizer.js";
import { bareChannelId, telegramLinks } from "./links.js";
import {
  DAVID,
  HELPER_BOT,
  JAMIE,
  SELF,
  T0,
  chatOf,
  messageIn,
  privateChatWith,
} from "./testing/fixtures.js";
import type { StoredUser } from "./message-store.js";
import type { TgChat, TgMessage, TgUser } from "./client/types.js";
import type { StoredChat, StoredMessage } from "./types.js";

const PROVIDER = ProviderId(`telegram:${SELF.id}`);
const SOURCE = SourceId(`telegram-messages:${SELF.id}`);

function user(u: TgUser, phoneE164?: string): StoredUser {
  return {
    userId: u.id,
    displayName: [u.firstName, u.lastName].filter(Boolean).join(" "),
    ...(u.username ? { username: u.username } : {}),
    ...(phoneE164 ? { phoneE164 } : {}),
    isBot: u.isBot,
    isDeleted: u.isDeleted,
  };
}

const USERS = new Map<number, StoredUser>([
  [JAMIE.id, user(JAMIE, "+12025550103")],
  [DAVID.id, user(DAVID)],
  [HELPER_BOT.id, user(HELPER_BOT)],
  [SELF.id, user(SELF, "+12025550101")],
]);

function stored(
  chat: TgChat,
  m: Omit<TgMessage, "chatId" | "box"> & { id: number },
): StoredMessage {
  const msg = extractMessage(messageIn(chat, m.id, m.date, m.text, m));
  if (!msg) throw new Error("fixture message was dropped");
  return msg;
}

function asStored(chat: TgChat): StoredChat {
  return {
    chatId: chat.id,
    kind: chat.kind,
    title: chat.title,
    ...(chat.username ? { username: chat.username } : {}),
    isArchived: chat.isArchived,
    isForum: chat.isForum,
    walkState: "done",
  };
}

function render(
  chat: TgChat,
  messages: StoredMessage[],
  extra: Partial<DayRenderInput> = {},
): ReturnType<typeof normalizeDayChat> {
  return normalizeDayChat({
    chat: asStored(chat),
    date: "2026-03-10",
    messages,
    users: USERS,
    replies: new Map(messages.map((m) => [m.msgId, m])),
    self: { id: SELF.id, phoneE164: "+12025550101" },
    providerId: PROVIDER,
    sourceId: SOURCE,
    ...extra,
  });
}

const JAMIE_CHAT = privateChatWith(JAMIE);
const GROUP = chatOf(-4005000005, "group", "Studio Northstar crew");

describe("normalizeDayChat", () => {
  it("renders one day of a private chat with ids, title, UTC times and dates", () => {
    const doc = render(JAMIE_CHAT, [
      stored(JAMIE_CHAT, {
        id: 1,
        date: T0,
        text: "Q4 budget review at ten?",
        senderId: JAMIE.id,
        outgoing: false,
      }),
      stored(JAMIE_CHAT, {
        id: 2,
        date: T0 + 120,
        text: "Yes, room 4",
        senderId: SELF.id,
        outgoing: true,
      }),
    ]);
    expect(doc.externalId).toBe(`${JAMIE.id}:2026-03-10`);
    expect(doc.title).toBe("Jamie Lopez — 2026-03-10");
    expect(doc.content).toBe(
      [
        "# Jamie Lopez — 2026-03-10",
        "",
        "**09:00** Jamie Lopez: Q4 budget review at ten?",
        "**09:02** You: Yes, room 4",
      ].join("\n"),
    );
    expect(doc.sourceCreatedAt).toBe("2026-03-10T09:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-03-10T09:02:00.000Z");
    expect(doc.metadata).toMatchObject({
      documentType: "conversation",
      tags: [],
      sourceUrl: `https://t.me/${JAMIE.username}`,
      appUrl: `tg://resolve?domain=${JAMIE.username}`,
      extra: {
        chatId: String(JAMIE.id),
        conversationId: String(JAMIE.id),
        chatName: "Jamie Lopez",
        chatKind: "private",
        isGroup: false,
        isArchived: false,
        messageCount: 2,
        mediaCount: 0,
        participants: ["You", "Jamie Lopez"],
        date: "2026-03-10",
      },
    });
  });

  it("names self by LID and phone and every other speaker by theirs, leaving bots out", () => {
    const doc = render(GROUP, [
      stored(GROUP, {
        id: 1,
        date: T0,
        text: "Rehearsal at six",
        senderId: DAVID.id,
        outgoing: false,
      }),
      stored(GROUP, {
        id: 2,
        date: T0 + 60,
        text: "Reminder posted",
        senderId: HELPER_BOT.id,
        outgoing: false,
      }),
      stored(GROUP, {
        id: 3,
        date: T0 + 90,
        text: "Call Sarah Mendez on +1 202-555-0177 or sarah@example.org",
        senderId: JAMIE.id,
        outgoing: false,
      }),
    ]);
    expect(doc.metadata.tags).toEqual(["group"]);
    expect(doc.metadata.people).toEqual([
      {
        role: "participant",
        name: "You",
        identifiers: [
          { kind: "lid", value: `telegram-user:${SELF.id}` },
          { kind: "phone", value: "+12025550101" },
        ],
      },
      {
        role: "participant",
        name: "David Lin",
        identifiers: [{ kind: "lid", value: `telegram-user:${DAVID.id}` }],
      },
      {
        role: "participant",
        name: "Jamie Lopez",
        identifiers: [
          { kind: "lid", value: `telegram-user:${JAMIE.id}` },
          { kind: "phone", value: "+12025550103" },
        ],
      },
      { role: "mentioned", identifiers: [{ kind: "email", value: "sarah@example.org" }] },
      {
        role: "mentioned",
        identifiers: [{ kind: "phone", value: "+12025550177" }],
        allowPersonCreation: false,
      },
    ]);
    expect(doc.metadata.extra?.participants).toEqual(["You", "David Lin", "Jamie Lopez"]);
    // A basic group has no link Telegram documents.
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.metadata.appUrl).toBeUndefined();
  });

  it("quotes the message replied to, and marks forwards and edits", () => {
    const original = stored(GROUP, {
      id: 1,
      date: T0,
      text: "Gates open at nine\nBring tickets",
      senderId: DAVID.id,
      outgoing: false,
    });
    const reply = stored(GROUP, {
      id: 2,
      date: T0 + 60,
      text: "Thanks!",
      senderId: JAMIE.id,
      outgoing: false,
      replyToId: 1,
      editDate: T0 + 300,
    });
    const forward = stored(GROUP, {
      id: 3,
      date: T0 + 120,
      text: "Parking is on Example Street",
      senderId: SELF.id,
      outgoing: true,
      forwardFrom: "Riverside Estate",
    });
    const doc = render(GROUP, [reply, forward], { replies: new Map([[1, original]]) });
    expect(doc.content).toContain(
      "> _David Lin: Gates open at nine_\n**09:01** Jamie Lopez: Thanks! (edited)",
    );
    expect(doc.content).toContain(
      "**09:02** You: (forwarded from Riverside Estate) Parking is on Example Street",
    );
    expect(doc.sourceUpdatedAt).toBe("2026-03-10T09:05:00.000Z");
  });

  it("renders media as placeholders and service messages in italics", () => {
    const doc = render(GROUP, [
      stored(GROUP, {
        id: 1,
        date: T0,
        text: "",
        senderId: DAVID.id,
        outgoing: false,
        media: { kind: "voice", durationSec: 75, isViewOnce: false },
      }),
      stored(GROUP, {
        id: 2,
        date: T0 + 60,
        text: "floor plan",
        senderId: JAMIE.id,
        outgoing: false,
        media: { kind: "document", fileName: "plan.pdf", isViewOnce: false },
      }),
      stored(GROUP, {
        id: 3,
        date: T0 + 120,
        text: "",
        senderId: JAMIE.id,
        outgoing: false,
        service: "message_pinned",
      }),
    ]);
    expect(doc.content).toContain("**09:00** David Lin: [Voice note, 1:15]");
    expect(doc.content).toContain("**09:01** Jamie Lopez: [Document: plan.pdf] floor plan");
    expect(doc.content).toContain("**09:02** _Jamie Lopez pinned a message_");
    expect(doc.metadata.extra).toMatchObject({ messageCount: 2, mediaCount: 2 });
  });

  it("has a placeholder for every media kind but link previews", () => {
    expect(mediaPlaceholder({ kind: "photo" })).toBe("[Photo]");
    expect(mediaPlaceholder({ kind: "video", durationSec: 9 })).toBe("[Video, 0:09]");
    expect(mediaPlaceholder({ kind: "video_note" })).toBe("[Video message]");
    expect(mediaPlaceholder({ kind: "audio", durationSec: 200 })).toBe("[Audio, 3:20]");
    expect(mediaPlaceholder({ kind: "sticker", summary: "🙂" })).toBe("[Sticker 🙂]");
    expect(mediaPlaceholder({ kind: "location", summary: "Riverside Estate" })).toBe(
      "[Location: Riverside Estate]",
    );
    expect(mediaPlaceholder({ kind: "poll", summary: "Which day?" })).toBe("[Poll: Which day?]");
    expect(mediaPlaceholder({ kind: "contact" })).toBe("[Contact]");
    expect(mediaPlaceholder({ kind: "animation" })).toBe("[GIF]");
    expect(mediaPlaceholder({ kind: "other" })).toBe("[Media]");
    expect(mediaPlaceholder({ kind: "webpage", summary: "https://example.com" })).toBeUndefined();
  });

  it("puts a message just before midnight UTC on its own day", () => {
    const late = Date.parse("2026-03-10T23:59:30.000Z") / 1000;
    const doc = render(JAMIE_CHAT, [
      stored(JAMIE_CHAT, { id: 9, date: late, text: "Night", senderId: JAMIE.id, outgoing: false }),
    ]);
    expect(doc.content).toContain("**23:59** Jamie Lopez: Night");
    expect(doc.sourceCreatedAt.slice(0, 10)).toBe("2026-03-10");
  });
});

describe("extractMessage", () => {
  it("keeps nothing of self-destructing, view-once or noise messages", () => {
    const base = messageIn(JAMIE_CHAT, 1, T0, "Disappearing", { senderId: JAMIE.id });
    expect(extractMessage({ ...base, ttlPeriod: 86_400 })).toBeNull();
    expect(extractMessage({ ...base, media: { kind: "photo", isViewOnce: true } })).toBeNull();
    expect(extractMessage({ ...base, text: "", service: "screenshot_taken" })).toBeNull();
    expect(extractMessage({ ...base, text: "" })).toBeNull();
    expect(extractMessage(base)).toMatchObject({ msgId: 1, text: "Disappearing" });
    expect(
      extractMessage({ ...base, media: { kind: "photo", fileId: "f1", isViewOnce: false } })?.media,
    ).toEqual({ kind: "photo", fileId: "f1" });
  });
});

describe("telegramLinks", () => {
  it("links supergroups, forums and channels to the message, public or private", () => {
    const group = chatOf(-1001234567890, "supergroup", "x");
    expect(bareChannelId(group.id)).toBe(1234567890);
    expect(telegramLinks(asStored(group), { msgId: 42 })).toEqual({
      sourceUrl: "https://t.me/c/1234567890/42",
    });
    const forum = chatOf(-1001234567890, "forum", "x");
    expect(telegramLinks(asStored(forum), { msgId: 42, topicId: 7 }).sourceUrl).toBe(
      "https://t.me/c/1234567890/7/42",
    );
    const channel = chatOf(-1009, "channel", "x", { username: "riverside_news_example" });
    expect(telegramLinks(asStored(channel), { msgId: 3 }).sourceUrl).toBe(
      "https://t.me/riverside_news_example/3",
    );
  });

  it("omits links Telegram does not document", () => {
    expect(telegramLinks(asStored(privateChatWith(DAVID)), { msgId: 1 })).toEqual({});
    expect(telegramLinks(asStored(GROUP), { msgId: 1 })).toEqual({});
    expect(
      telegramLinks(asStored(chatOf(SELF.id, "saved", "Saved Messages")), { msgId: 1 }),
    ).toEqual({});
  });
});
