---
name: bot-bots-api-tokens
description: Explain how to add, connect, use, approve, or revoke API keys and passwords entirely inside Bot-Bots.
metadata:
  topics: api token, api key, access token, saved credential, credential store, credential manager, keychain, secret setup, input my token, add my token, enter my token, keys and passwords, save passwords, store passwords, permissions.json
---

# API tokens and passwords

Start in the conversation. An explicitly supplied API key is intercepted and saved by the host before model inference; the value is omitted from chat history and model context. Known APIs connect immediately for all current and future bots. If the service is unknown, ask which service or for its documentation, without asking for the key again. Saying **“Let me give you my API key”** without a value or clicking **Add a key privately** opens the masked form. No Settings trip, bot-selection checklist, terminal or binding ID is needed. Bots cannot read secret values.

If a task needs a missing credential, use **credential_setup_request** with the service name and purpose. This opens the owner's private window and waits. The value field explicitly says the bot cannot read it. Windows Credential Manager and macOS Keychain encrypt it in the host OS store; a remote client saves on the server computer. Linux private-file mode is explicitly labelled plaintext. The bot receives only saved/cancelled status and an opaque connection ID, never the value. Respect Cancel; do not keep reopening it during the same task.

Known OpenAI/Claude entries connect automatically after **Save and connect**. For services, check `service_list` first: connected APIs are already usable with the same token for every documented action. Do not ask for another key or endpoint grant. Bottools Pages is built in; API docs supplied in chat and OpenAPI JSON can populate the complete catalog. Use `credential_setup_request` with the service name and purpose; include `apiJson` only for a documented catalog the app has not recognized. The human sees the HTTPS destination, permitted bot and action list and chooses **Connect the complete API**. It reuses an existing saved token without retyping. Once saved, continue the user's requested task with `service_call` or `page_publish`. Connection changes are visible during the same task. Unknown keys with no reviewed API can still be saved privately first. Never guess endpoints or claim a local preview is published.

For Pages, `page_publish` packages saved HTML into a ZIP with root `index.html`, deploys it and creates a short link when requested. The host adds the token; the model never reads it. The same connection covers site management, deployments, rollback, expiration and short links. A service HTTP 401/403 means the service rejected the saved token/access; it does not mean another endpoint grant is needed. Report the actual failure. Deletion/rollback needs the human to request it in the task. Terminal approvals and Google write permissions remain separate.

Service tools accept a connection ID, API ID, friendly name or API URL. Pages publishing, Bottools Pages and bottools.online/nettools/webhost refer to the same API. Do not interpret an old or mismatched ID as a reason to ask for a token; check `service_list`. New requests default to the latest shared connection for that API; explicit connection IDs select a particular saved account.

## Manage keys from Settings (alternative path)

1. Open **Settings & connections > Secrets stay with your computer**.
2. Click **Add key or password**. **Manage keys & passwords** opens the saved list. You can also open **Keys & passwords** in **Model workshop**.
3. Give it a friendly **Name** and choose **API key / token** or **Password** under **What are you saving?**.
4. Paste the value into the masked **API key or token** / **Password** field in that window. The server never returns it after saving.
5. Choose **Use it with**:
   - **Save privately for now** keeps it without granting any connection access. Click **Save securely**.
   - **A model provider** connects OpenAI, Claude/Anthropic, another HTTPS provider, or one of the existing HTTPS model servers. The app creates the saved binding and assigns it to the provider automatically. Click **Save and connect**.
   - **A bot's service or API** connects the complete API catalog using one token shared with all bots. Click **Save and connect** once; ordinary requests do not ask for another endpoint grant. Advanced legacy operations still use **Approve once**.
   - **Email or text warnings** connects authentication to the selected warning channel. Finish its destination and enabled setting in **Settings & connections**; saving the credential does not send a warning.

On Windows the host uses **Windows Credential Manager**; on macOS it uses **Keychain**. A phone or remote client saves to the server computer's credential store, not its own. Remote secret entry requires HTTPS. Linux uses Secret Service by default; an already configured private-file headless backend is explicit plaintext storage protected by OS file permissions, not an encrypted keychain.

## Model keys

**Model workshop → Frontier models** offers **Continue with ChatGPT** and **Continue with Claude**. ChatGPT uses its protected browser authorization flow. Claude runs the official, unmodified Claude Code tool and its browser login, keeping credentials with that tool. Existing Claude Code login is recognized; signing out affects its login on this computer. **Connect Claude API** remains an alternative. Do not collect Claude subscription tokens or copy them into API bindings. Enable models and turn off Local-only mode to use cloud inference. Each bot retains its duties; consent and verification stay with the human in the provider's browser.

Selecting a model provider saves the key and connects it automatically. The user does not need to enter a secret alias or a connection ID. Cloud models still require the owner's opt-in in Model workshop; saving a key alone does not switch inference to a paid provider. Local LM Studio normally needs just its URL and no key. Authenticated model bindings currently require HTTPS.

## Service passwords and bot permissions

Full API connections support bearer tokens and custom authentication headers. They retain useful nested JSON while filtering credential fields and redacting the actual token. API access is shared with all current and future bots, including workers. Each bot must still follow its duties and delegate work outside its role. Advanced password connections keep their selected bots and exact **Approve once** requests. Bots cannot read secrets or change grants. Browser password autofill and unrestricted authenticated scripts are separate capabilities.

## Update, connect or revoke

Open **Manage keys & passwords**. A saved card offers **Update or connect**. Leave the replacement field empty to keep the current value, or type a replacement to rotate it. Stored values are never fetched back into the form. **Revoke access** removes a specific connection while keeping the secret. The remove icon opens **Remove this secret?**; **Remove secret** deletes the stored value and revokes its connections.

The OS credential manager and the external controls remain independent revocation options. Reopening a stale form does not overwrite an outside revocation; refresh if the app says settings changed. Adding a new connection does not reactivate older paused grants. Secret protection also blocks bot terminal commands, including old approvals that have not run yet.

## Google and troubleshooting

Google normally uses **Plugins > Google > Sign in with Google**, not an API key. Load `bot-bots-google` for that flow. If a keyring is locked/unavailable, report that the host OS store needs to be available; do not ask the user to paste the value into chat instead. Missing stored values and paused connections are shown in the manager. Setup and permissions stay in the app for normal users; administrator CLI/file controls are optional advanced recovery tools, not the default path.
