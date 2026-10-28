// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Connecting a Telegram account: QR sign-in, an optional two-step password,
 * and the identity check (`docs/telegram-source.md` §6).
 *
 * Nothing touches disk until Telegram has accepted the sign-in and the account
 * is known to be the right one. The sign-in client keeps its keys in memory;
 * the only write is the account's credential record, and it happens last. Every
 * other exit — a refused password, the wrong account, a timeout — leaves the
 * config directory as it was.
 *
 * The two-step password is used once and never stored or logged.
 */

import { CredentialPersistError, createLogger, toErrorMessage } from "@omnesis/core";
import { AuthFailure, config, type AuthResult, type AuthSession } from "@omnesis/source-sdk";
import { TELEGRAM_FILE_KEY, loadAppCredentials } from "./credentials-spec.js";
import { telegramDeviceInfo } from "./device.js";
import { isAppCredentialRejected } from "./client/errors.js";
import { LOGIN_TIMEOUT_MS, MAX_PASSWORD_ATTEMPTS } from "./limits.js";
import { readSessionRecord, writeSessionRecord } from "./session-store.js";
import {
  TelegramError,
  type AdapterFactory,
  type DeviceInfo,
  type TgUser,
} from "./client/types.js";

const log = createLogger("provider:telegram").child("auth");

export interface LoginDeps {
  factory: AdapterFactory;
  device?: DeviceInfo;
  /** Overall wait for the scan and the password; tests shorten it. */
  timeoutMs?: number;
  now?: () => Date;
}

const PASSWORD_CHALLENGE = {
  kind: "fields" as const,
  title: "Enter your two-step verification password",
  instructions: "This account has a Telegram cloud password. It is used once and never stored.",
  schema: config.object({ password: config.secret({ label: "Password", required: true }) }),
};

const MISMATCH_REMEDY =
  "Scan with the Telegram account this connection belongs to, or add a new connection.";

export async function loginFlow(session: AuthSession, deps: LoginDeps): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const creds = await loadAppCredentials(configDir);
  const device = deps.device ?? telegramDeviceInfo();
  const auth = deps.factory.auth(creds, device);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Telegram sign-in timed out"));
  }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS);

  let wrongPasswords = 0;
  let signedIn: { self: TgUser; session: string } | undefined;
  try {
    try {
      signedIn = await auth.signInQr({
        signal: controller.signal,
        onQr: (url, expires) =>
          session.show({
            kind: "qr",
            title: "Scan this code with Telegram",
            instructions:
              "On your phone: Telegram → Settings → Devices → Link Desktop Device, then scan.",
            data: url,
            expiresAt: expires.toISOString(),
          }),
        onScanned: () => session.show({ kind: "wait", title: "Signing in…" }),
        password: async () => {
          if (!session.canShow("fields")) {
            throw new AuthFailure(
              "unsupported",
              "This Telegram account needs its two-step password, and this client cannot ask for it.",
              {
                remedy:
                  "Use the portal or an updated CLI to enter your Telegram two-step password.",
              },
            );
          }
          const answer = await session.ask(PASSWORD_CHALLENGE);
          return answer.password ?? "";
        },
        onInvalidPassword: async () => {
          wrongPasswords += 1;
          if (wrongPasswords >= MAX_PASSWORD_ATTEMPTS) {
            throw new AuthFailure(
              "credential-rejected",
              "Telegram rejected the two-step password too many times.",
              { remedy: "Check your Telegram cloud password and connect again." },
            );
          }
          await Promise.resolve();
        },
      });
    } catch (err) {
      throw toAuthFailure(err, timedOut);
    }

    const accountId = String(signedIn.self.id);
    if (session.accountId && session.accountId !== accountId) {
      await logOutQuietly(auth);
      throw new AuthFailure(
        "identity-mismatch",
        "The code was scanned by a different Telegram account than the one being renewed.",
        { remedy: MISMATCH_REMEDY },
      );
    }
    if (!session.accountId) {
      const existing = await readSessionRecord(accountId, configDir).catch(() => null);
      if (existing?.session && !existing.revokedAt) {
        await logOutQuietly(auth);
        throw new AuthFailure("duplicate", "This Telegram account is already connected.", {
          remedy: "Re-authenticate the existing Telegram connection instead of adding it again.",
        });
      }
    }

    const connectedAt = (deps.now?.() ?? new Date()).toISOString();
    try {
      await writeSessionRecord(
        {
          session: signedIn.session,
          userId: accountId,
          apiId: String(creds.apiId),
          connectedAt,
          ...(signedIn.self.phone ? { phone: signedIn.self.phone } : {}),
          ...(signedIn.self.username ? { username: signedIn.self.username } : {}),
        },
        configDir,
      );
    } catch (err) {
      // An authorization nothing can use is one the operator would have to
      // find and end by hand in Settings → Devices.
      await logOutQuietly(auth);
      throw new CredentialPersistError(TELEGRAM_FILE_KEY, accountId, err);
    }
    log.info(`Connected Telegram account ${accountId}`);
    return { accounts: [{ accountId, state: { status: "connected", since: connectedAt } }] };
  } finally {
    clearTimeout(timer);
    await auth
      .close()
      .catch((err) => log.debug(`Sign-in client close failed: ${toErrorMessage(err)}`));
  }
}

async function logOutQuietly(auth: { logOut(): Promise<void> }): Promise<void> {
  try {
    await auth.logOut();
  } catch (err) {
    log.warn(`Could not end the stray Telegram authorization: ${toErrorMessage(err)}`);
  }
}

function toAuthFailure(err: unknown, timedOut: boolean): Error {
  if (err instanceof AuthFailure) return err;
  if (timedOut) {
    return new AuthFailure("timeout", "Nobody scanned the Telegram sign-in code in time.", {
      remedy: "Start the connection again and scan the code within a few minutes.",
    });
  }
  if (!(err instanceof TelegramError)) {
    return new AuthFailure("unknown", `Telegram sign-in failed: ${toErrorMessage(err)}`);
  }
  if (isAppCredentialRejected(err.detail?.rpc)) {
    return new AuthFailure(
      "missing-credentials",
      "Telegram refused this app's api_id and api_hash.",
      {
        remedy: "Check the api_id and api_hash from my.telegram.org and enter them again.",
      },
    );
  }
  switch (err.code) {
    case "flood-wait":
      return new AuthFailure("unavailable", "Telegram asked to wait before signing in again.", {
        retryAfterMs: (err.detail?.seconds ?? 0) * 1000,
      });
    case "network":
      return new AuthFailure("unavailable", "Telegram could not be reached.");
    case "cancelled":
      return new AuthFailure("cancelled", "The Telegram sign-in was cancelled.");
    default:
      if (err.detail?.rpc === "AUTH_TOKEN_EXPIRED") {
        return new AuthFailure("challenge-expired", "The Telegram sign-in code expired.");
      }
      return new AuthFailure("unknown", `Telegram sign-in failed: ${err.message}`);
  }
}
