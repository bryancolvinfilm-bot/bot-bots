---
name: bot-bots-google
description: Help connect Google through browser sign-in and choose app/bot permissions in Bot-Bots.
metadata:
  topics: google, gmail, drive, sheets, google calendar, sign in, log in, oauth, plugin, plugins
---

# Google sign-in and permissions

Open **Plugins → Google**. The default is **Sign in with Google**: the app opens the system browser, Google handles login/consent, and a callback returns the result. The normal user should not upload a JSON credential file or paste API keys into chat. Bots do not type passwords, handle verification codes or approve consent for the user.

First check the current host's sign-in readiness and connection facts. Browser sign-in needs the app owner's one-time Google OAuth registration. If that is missing, explain that the owner must finish the app registration; clicking login cannot manufacture a Google client ID. Do not claim the Google account is connected or ask a normal user to create a Cloud project as part of everyday login. Custom registration remains an advanced owner option.

After identity sign-in, select the Google apps, permitted operations and allowed bots in the Google permission controls. Sign-in alone does not grant Gmail/Drive/Sheets/Calendar access. Read-only access and write actions are distinct. Requesting added scopes opens Google's consent flow again. The host supplies tokens to the Google adapter; they do not go into model prompts or team JSON backups.

Only operations actually granted to this bot appear in its runtime capabilities. Google writes such as sending email or changing files create an exact request awaiting owner approval in **Plugins**. Another bot's instructions, a routine or a successful login cannot approve that action. Check the completed result before claiming a message/file change happened.

If login fails, distinguish owner registration missing, browser consent denied, callback/server reachability, a locked host credential store, and app scopes not granted. Give the relevant next step without requesting secret values. Remote clients still talk to the server's Google connection; do not promise an arbitrary public callback or phone-local OAuth setup will work automatically.

Use **Disconnect** to remove the account connection. Reconnecting a moved host may be required because encrypted OAuth storage depends on that host's OS-held vault key. Team backup/restore is separate from Google and OS credential backup.
