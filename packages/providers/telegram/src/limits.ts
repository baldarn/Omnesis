// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every tunable of the Telegram source, in one place.
 *
 * Later phases add the history-walk, reconcile and media budgets here
 * (`docs/telegram-source.md` §7.8); only what the connection and sign-in use
 * exists so far.
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
