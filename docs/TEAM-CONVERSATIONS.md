# Team conversations

One conversation list serves the whole team. Each team conversation contains one persistent chat per bot. Selecting another bot keeps the selected conversation; selecting another conversation switches every bot's history. A new conversation gives the whole team a fresh space. Selection survives reloads. Switching the view does not stop work in another space.

Handoffs reuse the recipient's chat in the sender's team conversation. Each bot receives its own recent history, the initial human brief and bounded recent team context from the same space. Other spaces' chat histories and inbox receipts are excluded. Bot roles, shared skills, persistent memory, credentials, files and model choices remain independent of chat selection.

Earlier chats are retained under **Earlier conversations**. Migration merges each bot's old chat rows while retaining message IDs, content, task/run IDs, handoff receipts, draft/file results and attribution. References are updated in one transaction. A fresh conversation is created for new work. A consistent SQLite rollback snapshot is saved before the desktop workspace upgrade. JSON backups include spaces and bot-channel associations.

Scheduled tasks share a **Scheduled work** space with one chat per bot, keeping repeated runs out of the conversation list. Historical activity and handoff links select their matching team space.
