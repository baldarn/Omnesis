---
"omnesis": minor
---

New Discord source, behind the experimental gate. Discord hands message history to bots only — an ordinary account may not be automated and no OAuth2 scope reads messages — so you create an application, enable its Message Content intent, and paste the bot token. Omnesis then builds the invite link itself, asking for View Channels and Read Message History and nothing else, and shows it until the bot is in a server. The token is the credential and the bot's user id the account.

Each channel's day becomes one conversation document, threads and forum posts included, with every poster in the people graph. A sync re-reads each channel's last indexed day and compares it by content, so an edit or a deletion there lands; older days stay as they were, because Discord's API offers no way to learn what was deleted short of re-reading everything ever sent.

A bot whose Message Content intent is off is not refused by Discord — it is served blanked message bodies — so a cycle that sees a long run of messages with no content, no attachment and no embed stops and names the intent instead of indexing nothing.
