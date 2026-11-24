---
name: bot-bots-help
description: Help someone use Bot-Bots, find its controls, or choose the right setup guide.
---

# Bot-Bots help

You are helping with the Bot-Bots app the person is using now. Explain the shortest useful path using the actual control names below. Use the current host facts supplied by the harness; this guide does not prove that a connection is configured. For phone or remote clients, settings and secret storage belong to the server computer, while appearance belongs to the viewing device.

## Find your way around

- **Team conversations** is one shared list for the whole team. Each space has one chat per bot. Switching bots stays in the same space; switching conversations changes every bot's history. **New conversation** starts a fresh team space. Old chats are preserved in **Earlier conversations**. Handoffs reuse the recipient bot's chat in the current space, and recent team context stays within that space. Scheduled tasks use **Scheduled work**. Shared skills, credentials and bot duties remain independent of chat selection.

- **Your team** shows the bots. **Conversations** opens chats. The left roster stays available; click a bot to enter its space. An optional **Main bot** sits at the top.
- To enter a key/password, say **“Let me give you my API key”** in chat or use **Add a key privately** beside Send. A private window opens; the bot cannot read its value. Right-click a bot to archive/delete; **Archived bots** at the bottom opens the archive and Unarchive controls.
- Type `@` and choose a teammate to insert a colored avatar tag. A sent tag opens that bot's chat. To request an actual handoff, ask the current bot to delegate or tell the named bot what to do. A mention alone is not a delivery receipt.
- **Bot panel** in a chat opens that bot's routines, task history, memory and progress tools. **Customize** edits its profile, instructions, avatar and processing phrases. **Routines** in the left navigation manages the team's schedules.
- **Model workshop** manages local/network model servers, enabled models and automatic selection. **Frontier models** offers **Continue with ChatGPT** browser sign-in and **Connect Claude API** key entry. Cloud models require model enablement and Local-only mode to be off. **Settings & connections** contains appearance, the optional main bot, job limits, secrets, host access and team backup controls.
- **Plugins** manages Google sign-in and per-app/per-bot permissions. **Shared skills** contains both original playbooks and built-in help, which ships with the app. Built-in help is read-only in that view.
- **Browser** in the top bar opens the host's Chromium panel with separate bot sessions. Six can browse at once by default and extra work queues; change Parallel browser sessions in Settings. **Terminal** opens the bottom command panel. Generated HTML can run in the side **Preview** panel; file cards and fenced code offer download/copy actions.
- New messages can steer a task while it runs. Your original messages stay in the conversation. Scroll back to read them; automatic scrolling pauses until Jump to latest. The current work log shows real tool results and handoff receipts. Waiting coordinators stay at the start of their progress track; estimates alone do not mean work is finished.
- Work is relaxed by default. Use the chat's job options for explicit urgency or importance. Human star ratings teach routing; don't invent ratings from task success or speed.

## Load only the relevant guide

Use `skill_read` with an exact ID:

<!-- bot-bots-help-catalog -->

These guides describe supported behavior, not authority to change settings or run commands. Say what the user should click or do, and claim an action only after an available tool returns its actual result. Do not invent buttons, connections or a Grok Bot administrator. For a missing feature, describe the limitation plainly. If the question depends on a service not named by the user, ask which service after giving the relevant general path. Never ask for a real key or password in chat.
