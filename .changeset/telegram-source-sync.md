---
"omnesis": patch
---

The experimental Telegram source now archives your chats: private chats, Saved Messages, basic groups and supergroups, archived chats included, as one searchable conversation per chat per day. Broadcast channels stay out unless you switch them on, and chats you list under Excluded chats are skipped and removed from the index. The whole history is walked in the background at a measured pace that pauses when Telegram asks it to slow down, edits and deletions are followed, messages missed while the collector was offline are recovered, and self-destructing and view-once messages are never kept. Photos, files and voice notes appear as placeholders for now.
