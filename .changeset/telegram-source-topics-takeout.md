---
"omnesis": patch
---

The experimental Telegram source now shows forum topics: each forum message carries its topic's title, and a forum's day lists the topics it covers. The first full history read asks Telegram for a data export, which Telegram rate-limits less tightly; if Telegram holds the export until you approve it on your phone, history keeps being read the slower way, the Sources page tells you how to approve it, and a re-sync after approving starts the export at once. Switching broadcast channels off again removes their days and their files from the index. A message whose id another chat already holds is skipped with a warning instead of stopping every sync. The source is documented in the sources catalogue, labelled experimental.
