# Bot workshop, history and worker prototypes

## Bot panel and routines

Open a bot’s chat and toggle **Bot panel**. Its right panel has Routines, History and Memory tabs. The global routines page remains available. Routine creation in a bot panel preselects that bot. You can edit, pause, run or delete its routines. The hosting machine must remain awake; importing a backup pauses schedules.

## Personal processing phrases

Choose **Customize → Activity**. Enter one phrase per line for general work, coding, research, writing, planning, waiting and responding. Empty categories use the team vocabulary. Tool labels continue to describe the actual tool type rather than implying a search or command ran.

**Suggest from instructions & experience** uses the bot’s instructions, saved task categories and routine prompts to propose vocabulary. Suggestions use a local deterministic rule set, cost no model tokens and are never saved automatically. Review/use/edit them, then save the bot. These are playful status labels, not hidden model reasoning.

## History and compaction

SQLite stores a task record for every root/delegated work item: stable task ID, originating run/conversation, bot name/avatar, prototype link, original brief, result or failure, time, reported tokens, learned memory IDs and milestone labels. Existing run history is backfilled. A clone’s task ID is independent of its temporary roster entry.

Memory compaction is a reviewed, reversible operation. The slider chooses how many eligible older middle records to shorten. It preserves the first two tasks, first three memories, latest ten of each, pinned records, and all profile/behavior memories. Older task briefs/results and unpinned world/workstream memories are shortened deterministically; core facts are not rewritten by a summarizing model.

Preview reports active-detail bytes removed, compressed undo-archive cost and a conservative estimate of net logical record savings. This is not a promise about the filesystem’s SQLite file size: WAL pages/free pages, conversation copies and generated files are separate. Compaction never deletes conversations, instructions, code, ratings or artifacts. A compressed original archive supports Undo; edits after preview or compaction cause a conflict instead of silently overwriting newer information. The host must have no active runs when applying/undoing compaction. A separate secure database backup and offline maintenance are still needed to physically reclaim disk space or migrate hosts.

## Categories and prototypes

Set a category in **Customize → Personality**, or add a new category there. The team page filters by category; the permanent left roster groups by category.

Mark a bot as a **Worker prototype** to make it a reusable template and result coordinator. Direct human messages are blocked with an explanation. Ask another bot to delegate to it; `delegate_workers` accepts up to 30 scoped tasks. Clones return to the prototype, whose own model call compiles one best-of answer back to the requesting bot. The host records requesting bot > prototype > clone receipts and the prototype's synthesis task. The coordinator does not consume an extra handoff depth, so nested delegation can reach workers. Active/per-run clone caps (default 30), depth and model concurrency (default two calls) remain enforced. Each clone inherits the prototype's instructions/avatar/model preference; Google permissions are checked against its prototype at use time.

Drag permanent bots or prototypes between category headings in the left roster. Main bots stay pinned above categories, and active clones follow the prototype's group. Moving a bot changes placement only, preserving instructions and history.

Active workers appear indented below their prototype. Completed/cancelled/failed workers retire and disappear from the active roster; only a small identity record remains for historical attribution. Copied profile instructions are cleared on retirement. Their task results, files and learned memories remain stored. Prototype History aggregates those workers; click a result to open its originating conversation. Restart/restore does not relaunch clones or restore pending approvals.

Human ratings on a clone are attributed to its prototype for future bot/model/task routing, while each job retains its own worker/task identity. Completing a task still supplies no automatic star rating.

## Progress journeys

Chat shows one avatar track per real work item. Completed teammates reach the right edge while unfinished teammates keep working. `progress_update` can report a user-facing estimate and a milestone roadmap. Without a report, a bounded elapsed-time curve gives a rough visual estimate. Neither can reach 100% until the work actually completes. Waiting, failure and cancellation remain visible. These estimates are not an ETA or proof of quality; reduced-motion preferences disable movement transitions.

## Logo

`apps/web/public/logo.svg` is the editable vector source: three familiar bots joining hands around a star. `icon.png` and `resources/bot-bots.ico` are Chromium-rendered derivatives used by the desktop window, favicon and Windows executable.

## Host migration boundary

One active host owns a team; clients never run schedulers or model/tool loops. Continue using export/restore and a stopped-host filesystem backup for moves. Copy the workspace, database and encrypted secrets directory privately as separate assets. Future migration tools should checkpoint runs, acquire a new ownership lease and require an explicit cutover; automatic election and live host-to-host synchronization are not implemented.

## Archive, deletion and compact collaboration (0.2.13)

Right-click a permanent bot or prototype in the roster/team view. Archive stores its previous enabled state and preserves instructions/category, clears a main-bot role, pauses its routines, and hides it from normal lists, mentions and delegation. Archived bots opens a separate window at the bottom of the roster. Unarchive returns the profile to its previous category and availability without resuming routines or making it main automatically.

Delete requires a warning dialog that offers Archive instead. It clears the current profile instructions, description, bot/family memory and schedules, plus copied clone instructions. A minimal disabled name/avatar/ID tombstone remains for attribution. Chats, task results, files, original source archives and old backups are deliberately retained; deletion is not a secure purge of every historical copy, and does not revoke shared service grants. API mutations are owner-only. The whole bot/prototype family is protected while participating in an active run. Archive/deleted states survive backup restore.

A task with more than three distinct participants defaults to Grid. The grid shows unique avatars and short status, with full individual answers available by selection; detailed receipts and logs stay out of the DOM until requested. Details restores the full list. Larger teams omit the separate multi-row TaskJourney to avoid repeating a wall of bot activity. All receipts, work records and feedback remain stored.
