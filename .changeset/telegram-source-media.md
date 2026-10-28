---
"omnesis": patch
---

The experimental Telegram source now reads your media: voice notes are transcribed into the day's conversation, and photos and documents become searchable attachments of the day they were sent, under the same attachment settings as your other sources. Media is fetched a little at a time, so a long history keeps publishing its messages first; a download Telegram refuses for now is retried later, and one it no longer has is marked unavailable. Without a transcriber assigned, a voice note says so and is transcribed once one is. Other audio, video and stickers stay placeholders, and deleting a message removes its attachment.
