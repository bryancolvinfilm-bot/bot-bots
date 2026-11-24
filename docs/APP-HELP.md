# Built-in Bot-Bots help

Every runtime bot receives a short app-help bootstrap, independently of its imported instructions, category, model choice or prototype. It points at `skill_read({"id":"bot-bots-help"})`. The app-owned help library is separate from the team's SQLite skills and the byte-exact Grok archive. Creating/editing a persona or importing a team does not remove the bootstrap.

For app usage/setup questions, the host also selects up to two relevant help guides and appends them to an ephemeral copy of the system prompt before inference. This works without native tool calling. Ordinary requests receive no detailed guide text. Selection is based on the current task/newest live steering message, not old chat history. Retry/continuation do not duplicate the injected guide; a different new direction removes the old automatic help context. An already executed `skill_read` result remains part of that task's real tool history.

Help requests receive non-secret current host facts: OS, browser availability, local-only mode, whether a credential broker is attached, its backend/control directory/grant-enabled state, bot terminal policy, and Google sign-in readiness/connection state. A browser client or phone is not assumed to be the server. Keys, OAuth tokens and external permission-file contents are never loaded as documentation. Help offers instructions and cannot approve an action or edit external permissions.

The initial seven guides cover navigation, API tokens/passwords, models, bots/routines/memory, tools, Google, and hosting/backups. The API token guide uses the in-app Keys & passwords window, automatic model bindings and owner-selected bot service grants. It explains OS storage and revocation without sending normal users to commands, JSON files or manual binding IDs, and uses browser login for Google. The Google guide reports missing app-owner registration honestly.

## Add or update a guide

Create `resources/app-help/bot-bots-your-topic/SKILL.md` with this format. Keep these metadata values on single lines; topics are comma-separated phrases:

```markdown
---
name: bot-bots-your-topic
description: Explain the feature and when this guide applies.
metadata:
  topics: a specific control name, a setup phrase
---

# Friendly guide title

Explain the actual UI path and supported behavior. Describe actions for the human
without claiming they already happened or granting new permissions.
```

Use a `bot-bots-` folder/ID, matching name, a description of at most 300 characters and a guide under 20,000 characters. Use specific phrases rather than broad words that would pull unrelated tasks into app help. Examples, commands and URLs must match the running app. Keep the main guide short enough for small local models and link to another available `skill_read` ID only when useful.

The server discovers folders at startup. The index's `<!-- bot-bots-help-catalog -->` marker is filled with the current guide catalog, so new topics become discoverable without editing runtime code or every persona. Rebuild/repackage the app and reopen it to distribute changed guides. Do not put this library under the Grok reference directory or modify its checksummed files.

**Shared skills** shows built-in guides as **Included with Bot-Bots**, with read-only previews. Team playbooks remain editable as before. The server rejects attempts to overwrite a built-in ID through the skill API, and a team import cannot shadow its runtime content. Team JSON exports contain team skills; built-in docs come with the app release.

## Verification

`tests/app-help.test.ts` exercises every imported bot, a new bot and a prototype clone, relevant/irrelevant context selection, native `skill_read`, plain-text inference, API protection, and steering in and out of help. `scripts/verify-app-help.ts` checks the packaged UI against an isolated fake provider. `scripts/verify-help-local.ts` tests one real help response using only a currently available LM Studio model, without loading weights or enabling a cloud provider.
