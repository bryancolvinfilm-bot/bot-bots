# Secrets that stay outside the bots

## Complete service connections (0.2.14)

Give the bot the service's API documentation in chat, then say "Let me give you my Pages API token". Bottools Pages has a built-in complete catalog. Supplied OpenAPI JSON can define other HTTPS APIs with JSON actions or saved-page ZIP uploads. The private window shows the destination, all documented actions and which bot can use them. Choose **Connect the complete API** and **Save and connect**. One OS-held token covers every listed action without another endpoint grant. The form can reuse a matching saved key without showing or retyping it. An unknown key with no documented API remains storage-only until connected.

Bots see current connections through `service_list` and refreshed runtime facts, including after entry during an active task. `service_call` accepts catalog action IDs and documented inputs, not arbitrary authenticated URLs. `page_publish` packages a saved page into a ZIP with root `index.html`, deploys it through Bottools Pages and requests a short link when asked. The host also completes this publication for generated HTML when the user's task requests a public/short link. It returns the real service URL and records the publication; a local preview is not treated as a published site. Credential fields and the actual token are filtered from API results, including nested JSON. A 401/403 is reported as the service rejecting access rather than a missing grant.

These complete API grants live outside the workspace in the credential policy. Revocation/removal applies to the whole connection immediately; prototype permissions cover their temporary clones. Shell commands still require separate approval. Legacy manually configured single-endpoint `credential_use` grants retain **Approve once**. Google write approvals remain separate. API receipts persist in SQLite; an uncertain write after interruption is retained and must be checked before retrying rather than silently repeated. Backups include public endpoint metadata and receipts, never OS-held tokens or live grants.

## Conversational entry (0.2.13)

Say "Let me give you my API key" in chat or use Add a key privately beside Send. That request opens Private key entry instead of passing the value through a model prompt. The same entry flow handles passwords and token offers. Known provider connections are preselected; ambiguous service names stay unselected instead of guessing a destination. Values are masked, cleared on cancel/save, and never read back into the form. Existing same-named keys can be reused without retyping.

Bots use credential_setup_request with a service and purpose, optionally a validated fixed HTTPS operation proposal. The owner window displays the destination, bot permission and exact-approval requirement. The tool waits for saved/cancelled status and an opaque connection ID. Unknown services can store privately first; Help me connect it continues the conversation about a documented operation. Storage alone grants no tool access. Cancellation is not retried during that task. Restart and backup restore cancel unfinished setup requests. Their durable metadata and saved status contain no value.

Only owner, same-origin, JSON, HTTPS/non-loopback management routes can submit values or complete setup. The existing OS broker, fixed-operation validation, response filtering, terminal block and per-action approvals remain in force. Model/browser tools have no secret-read or management tool. Native private entry uses [Windows Credential Manager encryption](https://learn.microsoft.com/en-us/windows/win32/SecBP/handling-passwords) or macOS Keychain. An explicitly selected Linux private-file backend is correctly labelled plaintext rather than encrypted storage.


Bot-Bots can use a secret without putting it into a model prompt: the host reads the OS store, adds authentication to a fixed approved request, and returns only selected response fields. There is no bot tool to read keys/passwords, change grants, or approve a request, and no HTTP endpoint returns stored secret values. Authenticated owner-only endpoints support the in-app credential window; bots cannot invoke them through a model tool. Never paste real keys or passwords into chat, a bot's instructions, shared files, command arguments, or a generated script.

The Windows adapter has been checked on this machine using a temporary credential that was deleted afterward. macOS and Linux adapters use the same native keyring library but need testing on those operating systems. No real account credential was added as part of setup.

## In-app setup

Open **Settings & connections > Secrets stay with your computer > Add key or password**. The **Keys & passwords** window is also available in Model workshop. Enter a friendly name, choose API key/token or password, and paste the value in the masked input. **Save privately for now** stores it without granting use. **A model provider** creates and assigns its binding automatically. **A bot's service or API** selects an HTTPS destination, authentication, allowed bots, input/response fields and per-action approval. **Email or text warnings** connects the selected alert channel. No terminal or JSON editing is required for normal setup.

Saved cards support replacement without revealing the old value, additional connections, revocation and deletion. The owner UI sends a value only when saving/replacing it; values are never returned, stored in SQLite, written to the metadata catalog, logged, or placed in model prompts. Non-secret labels and grants live in private `manager.json` and `permissions.json` outside the bot workspace. Current metadata versions prevent a stale window from overwriting external revocations. New connections do not reactivate older paused grants.

Management requires owner access, same-origin JSON requests, and HTTPS for non-loopback secret entry. Browser/preview model tools cannot access the app's management origin. The manager protects internal Google vault keys, never exposes a read-secret endpoint, and blocks bot terminal execution before saving, including checking policy again for an older terminal approval. No in-app control enables unrestricted bot shell access. On Windows/macOS secrets use the existing native OS backend; Linux's explicit private-file mode remains an administrator-selected headless option.

The commands below are optional administrator/headless tools for legacy single-endpoint operations; regular users can remain in the app and use complete API connections above.

## What is ready on this Windows machine

External controls have been initialized here:

```text
%LOCALAPPDATA%\Bot-Bots\credentials\permissions.json
```

The file starts with `enabled: false`; no service operation is granted. `permissions.example.json` beside it contains a model connection and a Netlify **list-sites** example. These are examples, not configured accounts or website deployment tools.

From this project folder, use:

```powershell
& '.\Manage Bot-Bots Secrets.cmd' status
& '.\Manage Bot-Bots Secrets.cmd' set netlify-token
```

The second command asks for the token using hidden input. Supply only the alias on the command line; the token is not an argument, environment variable, or console output. You can create any alias using letters, numbers, dots, underscores and hyphens. Windows stores it through the native Credential Manager API under the Bot-Bots service.

To grant the example, edit the external `permissions.json` yourself. Copy the desired operation from `permissions.example.json`, keep only the bots and operations you intend, and set the outer `enabled` to `true`. For example:

```json
{
  "version": 1,
  "enabled": true,
  "storage": "os",
  "allowBotTerminal": false,
  "bindings": [],
  "operations": [
    {
      "id": "netlify-sites",
      "label": "List my Netlify sites",
      "enabled": true,
      "botIds": ["info-page-generate"],
      "url": "https://api.netlify.com/api/v1/sites",
      "method": "GET",
      "auth": { "type": "bearer", "secret": "netlify-token" },
      "inputFields": [],
      "responseFields": ["id", "name", "ssl_url"]
    }
  ]
}
```

Create a token in the service's own account controls, with the narrowest permissions the task needs. The example above lists existing Netlify sites; it does not create/deploy/delete a site. Website deployment needs a separate reviewed service operation.

Send a new message to the granted bot after changing grants. A compatible model can call `credential_use` with an operation ID and allowed JSON inputs. The app shows a **secret approval** button; review it under **Settings & connections → Secrets stay with your computer**. Every operation waits for **Approve once** or **Deny**, including reads. Bot-Bots reads the external policy and the OS credential again when you approve. Changing a destination or grant while it waits invalidates that approval. Denial does not approve a retry. Pending approvals exist only in this host session and never resume after restart.

## Revoking access outside Bot-Bots

- Remove one bot ID from an operation, set that operation's `enabled` to `false`, or set the outer `enabled` to `false` in the external file. Leave the protection file in place; Bot-Bots does not edit it.
- Delete/rotate the key in the service's own account settings for upstream revocation.
- Or delete the Bot-Bots credential through Windows Credential Manager / macOS Keychain Access / your Linux keyring manager, or run the external manager:

```powershell
& '.\Manage Bot-Bots Secrets.cmd' remove netlify-token
```

No restart is needed for future credential requests. Revoking access cannot undo an action already sent to the service. A request already in flight may finish; stop its task as well if needed. No cached credential is used to bypass a missing OS item or disabled grant.

## macOS

Install Node 24+ on the host and use the same built project:

Install dependencies on the target OS (`pnpm install`) so its native keyring binary is installed; do not copy Windows `node_modules` onto a Mac/Linux host. Then build with `pnpm build` if `dist/` is not supplied.

```sh
node dist/manage-secrets.js init
node dist/manage-secrets.js test
node dist/manage-secrets.js set netlify-token
```

The default controls live at:

```text
~/Library/Application Support/Bot-Bots/credentials/permissions.json
```

`storage: "os"` uses macOS Keychain through the native Security framework. Allow the legitimate host app's Keychain access when macOS asks. Use Keychain Access to inspect/revoke Bot-Bots items. A signed, consistently identified app is preferable for distribution; verify Keychain prompts and permissions on the actual Mac build before unattended use.

## Linux desktop

Run the same three commands above. The default directory is:

```text
~/.config/bot-bots/credentials/
```

`storage: "os"` explicitly requires a running, unlocked Secret Service provider, such as GNOME Keyring or a compatible KWallet/KeepassXC setup, on the host account's D-Bus session. The adapter does not silently switch to a transient kernel keyring or an insecure plaintext fallback. Use your desktop keyring manager to revoke items. A headless server may not have this service; choose the explicit private-file mode below.

## Headless Linux: private secret files

These files are plaintext protected by filesystem permissions, not encrypted. Put the directory outside the shared workspace and any repository, preferably under a dedicated host service account:

```sh
export BOT_BOTS_CREDENTIALS_DIR="$HOME/.config/bot-bots/credentials"
umask 077
node dist/manage-secrets.js init
mkdir -p "$BOT_BOTS_CREDENTIALS_DIR/secrets"
chmod 700 "$BOT_BOTS_CREDENTIALS_DIR" "$BOT_BOTS_CREDENTIALS_DIR/secrets"
chmod 600 "$BOT_BOTS_CREDENTIALS_DIR/permissions.json"
```

Edit the external policy to set `"storage": "file"`. Then use hidden input to create the value:

```sh
node dist/manage-secrets.js set netlify-token
```

The resulting file is `$BOT_BOTS_CREDENTIALS_DIR/secrets/netlify-token`, mode `0600`. You can provision that file directly using your own administrator/password-manager tooling, retaining mode `0600`; the directory must be `0700` and owned by the host service account. Symlink secret files are refused. The host reads this directory; **the model does not get the directory mounted or its contents added to context**. Set `BOT_BOTS_CREDENTIALS_DIR` in the actual service environment when starting the host, not only in a shell the service does not inherit.

For a Linux service, a stronger deployment separates the credential-using host from untrusted command execution under another Unix account/container, with the secret directory readable only by the trusted host account. systemd `LoadCredential=` / `LoadCredentialEncrypted=` can provision private files into a service's credential directory, but that integration must be configured by the administrator; Bot-Bots does not install a system service or silently grant another account access.

## Model API keys and alert tokens

Bot operations currently support Bearer tokens, a configured custom authentication header, or HTTP Basic authentication. For Basic authentication, use `"auth": { "type": "basic", "username": "your-account", "secret": "password-alias" }` and store the password through the hidden `set password-alias` prompt. The model never supplies or receives that password. Arbitrary CLI environment injection and browser password autofill are deliberately not provided by this broker. Log into web pages yourself through the Computer panel; additional service adapters can provide narrower authenticated actions later.

Model/alert authentication runs in the host rather than through a model tool. Give each connection an exact external binding:

```json
{
  "id": "openai-main",
  "secret": "openai-key",
  "purpose": "model",
  "url": "https://api.openai.com/v1"
}
```

Put it in `bindings`, save the key with the external manager, and enter `openai-main` in **Model workshop → Edit server → Saved credential connection**. The credential works only for that URL and purpose. Claude uses a binding for `https://api.anthropic.com/v1`. Local LM Studio remains key-free unless you configure authentication. No paid provider is enabled by this setup.

Alert bindings use `purpose: "alert"` and the exact delivery endpoint. Set the binding ID in the email/SMS settings. These automatic host-authentication bindings do not ask for approval on every model or alert request: the owner has already chosen the connection and granted its fixed purpose. A revoked binding never falls back to a legacy environment key. Legacy environment-variable configuration remains available, but secret-bearing variables are not inherited by terminal children.

## Google connection storage

Production desktop/headless hosts now keep the Google vault's encryption key in the OS store (or explicit private-file backend). OAuth tokens remain encrypted on disk and never enter model context. On first use, an existing adjacent `master.key` is migrated, verified in the OS store, and removed. After migration, deleting the OS vault key blocks further reads; the app does not recreate a missing key to bypass revocation. The OS item uses an alias beginning `google-vault-`, scoped to that host data path. Reconnect accounts on a new machine/data path; team JSON backups never carry OS keys, OAuth tokens, or external credential grants. Keep OS recovery/credential backup decisions separate from team backups.

If that OS key is permanently lost, stop the host and move the corresponding `data/secrets/google.vault` aside into a private backup (or remove that credential cache), then restart and reconnect Google. Reauthorization establishes a new key after the old encrypted cache is gone. Do not delete the team database or use this as a way to reuse old approval. The same directory can be under a custom `BOT_BOTS_DATA_DIR`.

## The security boundary

The trusted host must briefly hold a key in memory to authenticate a request. **Never exposed to bots** means the supported model/tool path: no raw-secret tool, prompt injection, key in shell arguments, general environment injection, response headers/cookies, or raw authentication-error bodies. Approved operations use fixed HTTPS destinations, no redirects, allowed input fields and selected response fields; known raw/URL/base64/hex credential echoes are redacted. This is not a universal sanitizer for arbitrary transformed secrets returned by a malicious service. Grant only trusted service endpoints and narrowly selected response fields.

Response projections return selected scalar fields only; nested objects are withheld, and obvious token/password/session/credential field names cannot be selected. Login/token-exchange APIs need a dedicated host adapter that stores the new credential instead of returning it to a model.

An OS keyring protects credentials at rest and against other users; it is not a sandbox for arbitrary code already running as the credential-owning account. Windows generic credentials are available in the account's logon context; Secret Service does not mandate application access controls. Bot-Bots therefore blocks **bot-requested terminal commands by default once external credential controls are initialized**, even when all grants are disabled. The human's manual terminal is still a full shell and can expose secrets if explicitly used to do that. Setting `allowBotTerminal: true` outside the app opts into that same-account risk; it cannot preserve a guarantee against arbitrary bot-authored commands. For a stronger boundary, run untrusted execution under a different OS principal/container and keep the credential broker on the trusted side. This build has not provisioned a separate Windows/macOS service account or OS sandbox.

## References

- [Microsoft: CredRead and the user's credential set](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)
- [Apple: Keychain services](https://developer.apple.com/documentation/security/keychain-services)
- [Secret Service: access-control limits](https://specifications.freedesktop.org/secret-service/latest/ch10.html)
- [systemd: service credentials](https://www.freedesktop.org/software/systemd/man/262/systemd.exec.html#Credentials)
- [Native keyring adapter and explicit Linux backend selection](https://github.com/Brooooooklyn/keyring-node)
