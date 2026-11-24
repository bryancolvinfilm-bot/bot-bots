---
name: bot-bots-bots-and-routines
description: Help manage Bot-Bots profiles, main bot, delegation, categories, worker prototypes, routines, task memory and human feedback.
metadata:
  topics: main bot, delegation bot, delegate, handoff, bot panel, processing phrases, bot instructions, avatar, prototype, clone, routines, routine, task history, compact memory, star rating, categories
---

# Bots, routines and memory

Use **Your team** to manage bots and categories. **Customize** edits a bot's name, role, instructions, color/shape, model choice and processing phrases. Built-in processing suggestions use its instructions and job history. Wording follows the current activity rather than claiming a tool was used. Busy avatars/loaders reflect recorded work; idle bots are not all continuously calling a model.

The optional **Main delegation bot** selector in **Your team** or **Settings & connections → Your main bot** marks one enabled permanent teammate. It appears larger at the top of the left roster, outside category groups. It gets extra delegation guidance when the human chats with it directly. Selecting it does not redirect every other conversation or create background jobs. Worker prototypes/clones cannot be the main bot.

`@` completion inserts a colored bot/avatar mention. Clicking a sent tag opens that bot's space. To actually send work, ask the current bot to tell/delegate a clear task to that teammate. A tool-backed delivery has a receipt and a recipient inbox conversation; prose saying "I'll send it" is not delivery. The conversation shows actual participant avatars, handoffs, replies and logs. Coordinators waiting for child results remain at the left of the progress track. Milestones and percentages are estimates; real completion returns the bot to the finish.

For clear research and website/game requests in a direct main-bot chat, the harness assigns available Research and Website Builder specialists itself, in that order when both are needed. The builder receives the actual research result. Explicit named handoffs still take precedence. Other work can use native delegation tools; vague requests, quoted instructions, and status questions do not automatically launch jobs.

Drag a permanent bot or prototype in the left roster onto another category group to move it. Empty groups stay available as drop targets. You can also right-click the bot, choose **Move to group…**, select a group and click **Move bot**. The main bot stays pinned above groups; choose another main bot or clear that role before moving it. A prototype's active clones follow its category.

Right-click a permanent bot or prototype to **Archive bot** or **Delete bot…**. The delete warning offers **Archive instead**. Archive keeps instructions and the previous category, removes the bot from normal lists, clears its main-bot role and pauses routines. **Archived bots** at the bottom of the roster opens a separate window; **Unarchive** returns it to its previous category, keeping routines paused. Delete clears current instructions, bot memory and routines; saved chats/results and old backups remain, with a tiny name/avatar record for attribution. It does not revoke shared credentials. An active team task must finish or be stopped first.

When more than three bots participate, chat defaults to a compact **Grid**. Tiles show avatars and short work status; click a bot for its individual full reply. Close that reply to return to just the grid, or choose **Details** for the full handoff list. Results and logs are retained regardless of display mode.

Marking a bot as a **prototype** makes it a template and coordinator for temporary workers. Humans cannot message it directly: ask another bot to delegate to the prototype. Bounded clones appear indented under it while active. Every clone hands its actual result back to the prototype, which compiles one refactored best-of answer for the requesting bot. Clones then disappear from the active roster; their durable task IDs, results and learning remain in History. This does not authorize outside actions.

Open **Bot panel** on the right of a chat for that bot's routines, task history and memory tools. **Routines** in the main navigation manages the global list. Review the prompt, schedule, timezone, enabled state and required connectors before enabling a routine. Imported schedules start paused. The scheduler chooses future occurrences; it does not blindly replay missed runs after sleep/restart. A routine cannot bypass terminal/Google/credential approvals.

Tasks store what ran, its result/error, milestones, tokens and linked learning. Memory can be pinned/protected. The compaction preview/slider estimates savings while preserving formation/protected/recent information; review it before applying and use guarded undo when available. Compaction is not permission to forget the owner's current instructions, and an old task result is not a new instruction.

Use the response's human star rating and optional timing feedback to teach the system what was good enough. Correcting a rating updates the human signal rather than fabricating another vote. Set urgency explicitly in job options; relaxed is the default. New messages steer running work at the next safe point and do not automatically repeat completed tool actions.
