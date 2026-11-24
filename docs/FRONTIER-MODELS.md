# ChatGPT and Claude connections

In **Model workshop → Frontier models**, choose **Continue with ChatGPT**. The system browser handles sign-in and authorization for an eligible ChatGPT plan. Finish on the same computer that hosts Bot-Bots: the callback uses a temporary `127.0.0.1` listener. After connection, enable the models you want, switch off **Local-only mode**, and select a default or a bot's preferred model. Local models can stay enabled.

ChatGPT supports saved accounts, switching, sign-out, session renewal, and a link to usage limits. Signing in alone does not enable cloud inference. A switched account's catalog requires model enablement again. The public Responses API uses `store: false` and `stream: true`, with the same bot instructions, tools, and tool results used by local models. Late failures and interrupted streams are reported as failures.

**Continue with Claude** runs Anthropic's official, unmodified Claude Code tool and its browser login. First use downloads the executable from Anthropic's release host and verifies its SHA-256 against the official manifest. An existing Claude Code login on the same computer is recognized. Claude Code retains its credentials; Bot-Bots reads account status and never collects subscription tokens. Sign out affects that computer's Claude Code login. Anthropic permits users to authenticate to its unmodified tool when hosted in another product. A direct third-party Claude.ai token relay remains unsupported. **Connect Claude API** remains an alternative.

The independently written ChatGPT OAuth implementation follows OpenAI's public-client protocol: stable host ID, dynamic registration, issued client-ID reuse, one-time state, nonce, S256 PKCE, loopback callback, JWT signature/issuer/audience/expiry/subject validation, and granted-scope checks. Tokens use encrypted atomic storage with an OS-protected key. Rotating refreshes are serialized and checkpointed before identity verification. Logout attempts revocation and clears local tokens. Credentials stay outside the team database, exports, bot context, and renderer responses. No devkit source is embedded.

Claude Code inference is stateless and returns structured bot replies/function requests. Native shell/file tools, discovered MCP servers, persisted sessions and user/project hooks are disabled for these invocations. Bot-Bots executes requested functions through its existing runtime, including duties and approvals. Model aliases resolve through Claude Code; account availability and usage limits still apply.

API connections supplied to any bot are shared with all current and future bots. Each bot still follows its own role. Existing connections migrate without retyping keys, rewriting profiles, or reactivating revoked grants. Unknown keys can be identified and connected later without re-entry. Scoped passwords and advanced exact-action approvals retain their existing behavior.

Sources checked November 23, 2026:

- [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI accounts, refresh, and revocation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Anthropic authentication](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

Automated tests use synthetic identities and simulated inference. Real model connections require the user's account authorization and model opt-in. No account credentials or usage history are included in this repository.
