// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every tunable of the Telegram source, in one place.
 *
 * `docs/telegram-source.md` §7.8. Phase 3 adds the media budgets.
 */

/** Wrong two-step passwords accepted before the sign-in gives up. */
export const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * How long one sign-in waits for the code to be scanned and the password typed.
 *
 * Under the gateway's fifteen-minute auth-flow expiry, so the flow reports its
 * own timeout instead of being cut off without one. The code itself rotates
 * every thirty seconds or so inside that window.
 */
export const LOGIN_TIMEOUT_MS = 13 * 60 * 1000;

/** How long a sync waits for the live connection before reporting a network failure. */
export const CONNECT_TIMEOUT_MS = 60 * 1000;

/**
 * The longest flood wait the client sleeps through on its own. A longer one
 * surfaces as a `flood-wait` error, so a sync can stop instead of hanging.
 */
export const FLOOD_SLEEP_MAX_MS = 10_000;

/** Messages per `messages.getHistory` request (Telegram's own ceiling). */
export const HISTORY_PAGE_SIZE = 100;

/** Upstream requests one `sync()` page may make for the walk and reconcile. */
export const WALK_REQUESTS_PER_PAGE = 20;

/** The least time between two upstream requests of the walk, across pages. */
export const HISTORY_MIN_INTERVAL_MS = 1000;

/** The walk stops when the run has less than this left before its deadline. */
export const WALK_DEADLINE_MARGIN_MS = 120_000;

/** Dirty days rendered per `sync()` page. */
export const DRAIN_DAY_LIMIT = 200;

/** How often every dialog is listed again to find missed messages. */
export const FULL_RECONCILE_INTERVAL_H = 24;

/** How far back a presence check looks for lost edits and deletions. */
export const RECONCILE_WINDOW_DAYS = 14;

/** Message ids per presence-check request. */
export const PRESENCE_BATCH_SIZE = 100;

/** An outage longer than this may have lost updates, so it asks for a reconcile. */
export const GAP_SUSPECT_OUTAGE_S = 900;

/** A deletion for a message not archived yet is kept this long, waiting for it. */
export const PENDING_DELETION_TTL_DAYS = 30;

/** A flood wait longer than this is reported to the operator as an issue. */
export const FLOOD_ISSUE_THRESHOLD_S = 600;
