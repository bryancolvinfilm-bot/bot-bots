# One server, many clients

The server owns the SQLite team, model calls, tools, schedules and secrets. A desktop in **Server** mode runs that host with its UI. **Client** mode loads an existing server’s UI without opening a local team database or starting schedulers/inference. Phones and tablets open the same server URL in a browser; native mobile apps are not required for this stage.

## Set up the host locally

1. Open Settings → Server, clients & devices on the hosting machine.
2. Create an owner name/password (at least 12 characters). Passwords use salted scrypt; API keys/sessions are random and stored as hashes.
3. Choose how the phone will reach it. Keep one host per data directory. The Windows desktop normally serves `http://127.0.0.1:3211`; the headless launcher uses port 3210.
4. After setting up an HTTPS tunnel/hostname, save its public HTTPS origin in Settings. This explicitly allows that hostname. Saving a public origin disables implicit localhost owner access and creates a signed-in host session, so a proxy cannot get owner access simply by forwarding from loopback. Do not rewrite a public request’s Host to localhost or strip forwarding headers; preserve the public hostname through your proxy. No wildcard allowed origins are added automatically.
5. Open the HTTPS server URL on your phone. Sign in as owner, or generate a five-minute, one-use pairing code on the host for a Viewer or Operator device. Pairing has attempt/rate bounds. Sessions use HttpOnly, SameSite cookies and are revocable in Settings.

Before any public URL is configured, local loopback UI access remains convenient owner access. Requests with public/untrusted hostnames or forwarding headers do not receive that bypass. An optional `BOT_BOTS_TOKEN` remains an owner bearer credential; use 24+ random characters and keep it private. For an intentional LAN bind, set `BOT_BOTS_HOST=0.0.0.0`; remote API access still requires authentication, and hostnames must be configured appropriately. Prefer the HTTPS tunnel workflow over an unauthenticated or plain-HTTP public port.

## Stable HTTPS access

**Cloudflare Tunnel** is a practical public-hostname option: create a tunnel in your own Cloudflare account and route an owned hostname to this host’s local URL. Its connector makes outbound connections; it does not require opening a router inbound port or maintaining home dynamic DNS. Follow [Cloudflare’s setup guide](https://developers.cloudflare.com/tunnel/get-started/) and [connectivity requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/). Run the connector on the same machine/service account appropriate for your deployment. Use a named stable tunnel/hostname for a Google Web OAuth callback; a changing temporary URL requires changing Google’s registered redirect URI.

For private access, a managed VPN/private network is another option; all client devices must join that network. Public router forwarding with dynamic DNS is possible but requires TLS termination, hostname preservation and firewall maintenance. No forwarding, DNS change, tunnel, service installation or firewall rule has been applied by Bot-Bots. The app does not manufacture a reachable public URL by saving the address.

Keep the machine awake, LM Studio reachable from it, and the app/headless process running. For dependable unattended hosting, add OS service startup, connector restart policy, encrypted backups and an external host-down monitor. Existing model-outage email/SMS slots cannot alert if the entire host is powered off. Public deployment still needs operational testing on the selected hostname, proxy and network; no public site was deployed during local verification.

## Access for apps and devices

- **Owner:** configuration, bot/routine/memory management, backups and explicit terminal/Google approvals.
- **Operator:** read team state, start tasks/routines, steer/cancel runs. Cannot alter configuration or approve terminal/Google actions.
- **Viewer:** read team progress, conversations and results. Cannot submit work or make changes.

These roles share one team; they are not isolated tenants or bot-specific private accounts. Signed-in devices and API keys can be revoked. An API key is displayed once; call `Authorization: Bearer bb_…`. For example, read `GET /api/bootstrap`, `GET /api/runs/:id`, or the authenticated SSE stream at `GET /api/activity/events`. Operators may use `POST /api/runs` with `{ "botId": "worker1", "prompt": "…" }` and steer through `POST /api/runs/:id/messages`. No key has an automatic permission to approve a terminal command or external write unless it is the separate legacy owner token.

Cookies are for the server’s own browser UI. Separately hosted UI clients should use an API key and an explicitly allowed origin (`BOT_BOTS_ALLOWED_ORIGINS`); the default has no wildcard CORS. Desktop Client mode loads the remote origin directly, preserving normal sign-in and avoiding a duplicate local host. To switch desktop roles, choose the role/server URL in Settings and apply/restart. Deployment overrides are `BOT_BOTS_MODE=client` and `BOT_BOTS_SERVER_URL=https://bots.example.com`.

If a client cannot reach its server, the desktop offers retry or a return to Server mode. `BOT_BOTS_MODE=server` can also override a saved client preference for recovery.

## Backup and future moves

JSON export includes bot identities, categories, routines, task history, memory, compaction archives, conversations, artifacts and action history. It does not include authentication credentials, Google grants, workspace filesystem contents or browser cookies. Stop the old host before a filesystem/database move, back up the workspace and protected secrets separately, restore the team on the new host, review/reconnect accounts and keep restored routines paused until ready. Automated server migration, encrypted transfer bundles, live synchronization and host election remain future work.
