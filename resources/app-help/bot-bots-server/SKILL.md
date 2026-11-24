---
name: bot-bots-server
description: Help start Bot-Bots, distinguish desktop/server/client modes, configure remote access, or back up and move a team.
metadata:
  topics: start bot bots, start the app, start app, start server, server mode, client mode, remote access, phone, pairing, api access, api access key, backup, restore, move the server
---

# Starting, connecting and backing up

For the project installation on this Windows machine, double-click **Start Bot-Bots.cmd** in the project folder. It opens the latest packaged Electron app and uses the project's `data/` team. A desktop running in server mode hosts the team and supplies Chromium/preview tools. Its default local web address is `http://127.0.0.1:3211` while open; the host can override the port.

**Start Bot-Bots Server.cmd** starts the headless TypeScript/Node host and scheduler for the same team, with default `http://127.0.0.1:3210`. It can be used from a browser without keeping an Electron UI open, but currently has no Chromium browser adapter. Use either desktop-host or headless-host for one data folder; the host lock prevents simultaneous schedulers sharing the database. Close the old host before starting another. A model server such as LM Studio is a separate process and must also be reachable for inference.

In **client mode**, this app/device connects to an existing Bot-Bots server instead of running its own team or local scheduler. **Settings & connections → Connect to another server** selects a server URL and connection credentials. Processing, filesystem, terminal, model endpoints and service secrets belong to the host. Device appearance can be local. A server with a UI and a GPU/headless server use the same host/data design; mobile platforms are not all packaged as native Electron apps.

For a phone on the LAN, the host must listen on a reachable interface, the firewall must permit that port, and the phone must use the host's LAN address. `localhost` on the phone is the phone itself. App access controls support an owner login, one-use pairing and scoped/revocable API keys. Those API access keys authorize access **to Bot-Bots**, unlike model/service tokens; do not conflate them. Do not paste any access key into chat.

For outside-the-LAN access, the owner must configure actual reachability and HTTPS through a suitable authenticated tunnel/reverse proxy or a deliberate network setup. A changing IP, DNS, forwarding and TLS are deployment choices; the app does not automatically publish this computer or bypass a router. Use the access settings' real server URL and permissions. Don't invent a public link or suggest exposing an unauthenticated port. A public client requires HTTPS; private LAN HTTP is supported.

Use the backup export/restore controls in **Settings & connections** for the team JSON (profiles, model settings, chats, ratings, routines, memory and saved artifacts represented in the database). Restore validates the records, keeps a rollback snapshot and pauses imported routines. External permissions, OS credentials and Google tokens are not in team JSON. Workspace files and a full host filesystem backup are separate; a database export is not a complete machine backup.

Before moving or directly copying a live SQLite team, stop its host or use a consistent SQLite snapshot including committed WAL data. Keep the database, workspace files, desired desktop preferences and separate credential/reconnection plan. Use the new host's `BOT_BOTS_DATA_DIR` deliberately. Do not claim an automated server transfer tool or complete OS credential portability exists today.
