---
"omnesis": patch
---

Experimental Telegram source, offered only when the collector runs with `OMNESIS_EXPERIMENTAL=1`: connect a Telegram account with your own API app from my.telegram.org, a QR code scanned from Telegram, and the two-step password when the account has one (used once, never stored). The connection survives a collector restart without signing in again, its local archive and connection cache are encrypted with the collector's new `telegram-store` key, and a session ended from another Telegram device puts the source in needs-auth. Chats are not archived yet.
