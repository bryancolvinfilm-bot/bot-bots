# Bot-Bots

A local-first desktop app for building a team of bots with different roles and interchangeable models. React and TypeScript provide the interface, Electron hosts the desktop app, and a separate TypeScript server runs the bots.

Fresh installations start with **one generic bot**, **First Bot**. Customize its instructions and appearance, then add teammates as needed. No personal profiles, conversations, credentials, or schedules ship with the app.

## Run from source

Install **Node.js 24 or newer** and **pnpm 11**. From the project folder:

```sh
pnpm install
pnpm build
pnpm desktop
```

The desktop host opens at `http://127.0.0.1:3211`. For a browser interface without the desktop browser driver:

```sh
pnpm start
```

Then open `http://127.0.0.1:3210`. On Windows, the included `.cmd` launchers can open a built desktop/server app. Build and package a desktop folder with `pnpm package:desktop`.

On Windows, run `pnpm build:launcher` to create **Bot-Bots.exe** in the project folder. Double-click it to open the newest packaged desktop version, or the built source app if no package exists. It opens without a command window and uses the project's `data/` folder. Keep the launcher beside `release/` and `data/`; it does not need rebuilding for each new app version.

For development, run `pnpm dev` for the server and `pnpm dev:web` in another terminal for the Vite interface.

## Models

LM Studio is supported at `http://127.0.0.1:1234/v1`, along with other compatible local or network servers. Model workshop discovers available models, follows loaded local models, and lets you choose defaults and preferences per bot.

**Model workshop → Frontier models** also offers:

- **Continue with ChatGPT** for eligible ChatGPT plan authorization.
- **Continue with Claude** through Anthropic's official, unmodified Claude Code tool and its own browser sign-in. The host downloads and checksum-verifies that tool when needed; Claude Code retains its login credentials.
- API-key connections for OpenAI, Anthropic, and compatible providers.

Every chat has a model/effort picker: connected online models appear first, followed by loaded local models. Choices are saved per conversation; bot profile defaults remain suggestions. Selecting an online model directly in chat opts it in without a separate settings step. Each bot retains its role and normal tool permissions. See [model connections](docs/FRONTIER-MODELS.md).

Online providers manage their context capacity by default, with an optional manual app cap. Local models follow the actual loaded context reported by their server. Automatic working-context compaction preserves the current request and completed results while retaining the full visible history and local checkpoints.

Click the model indicator in the top bar to apply a model and effort to the whole team once, or return all bots to their saved profile defaults. Individual chats can change afterward. Token counters beside messages show live estimates while responding and provider-reported usage when available, including model calls for tools and context compaction.

Bot settings, chat and team controls share one dropdown of connected online models and loaded local models. Worker clones follow their prototype's effective conversation model and effort; Auto is resolved once for the batch. Changes reach active inherited workers while preserving completed tool work, and live counters name the model actually running.

## Team spaces and collaboration

One conversation list serves the whole team. Each conversation contains one chat per bot. Switching conversations changes every bot's history together. Handoffs reuse the recipient's chat in that space, with recorded task receipts and results. Recent team context stays within the selected space.

Bots support customizable SVG avatars, processing animations, role instructions, memory, routines, model preferences, and temporary worker prototypes. Your messages appear on the right and bot replies on the left. Active processing animations stay visible while you scroll.

See [team conversations](docs/TEAM-CONVERSATIONS.md) and [bot workshop](docs/WORKSHOP.md).

## Tools and shared skills

- Embedded **Browser** with independent bot sessions, live web research, and human takeover.
- **Terminal** with a fresh approval for each bot-requested command.
- Saved Markdown, HTML, and code files, plus isolated interactive page previews.
- Shared Markdown skills with creator attribution, editing, and confirmed deletion.
- Conversational service connections shared across bots, with protected credentials and documented API catalogs.
- Google plugin integration for selected apps/actions, after configuring your own OAuth registration and granting consent.
- SQLite persistence, JSON team backup/import, and desktop/server/client operation.

API keys are saved on the host. Supplied chat credentials are intercepted before model inference and omitted from ordinary history. Password entry and connection management use the private credential UI. Bot terminal requests still require approval. Read [secret storage](docs/SECRETS.md) and [remote access](docs/REMOTE-ACCESS.md) before exposing a host.

For optional Google registration, copy `resources/google-oauth.example.json` to the ignored `resources/google-oauth.json` and configure your own client. See [Google setup](docs/GOOGLE-PLUGIN.md). Environment options are documented in [.env.example](.env.example).

## Development checks

```sh
pnpm check
pnpm test
pnpm build
```

The public tests use synthetic teammates and mocked providers. They do not require personal bot backups or paid model inference. Private archives and local-only verification files are excluded from this repository.

The public source contains no runtime databases, conversation exports, local bot profiles, credentials, browser profiles, downloaded model/login tools, build output, or unrelated game experiments. Keep your own data in the ignored `data/` folder and make private backups separately.

## License

[GNU Affero General Public License v3](LICENSE). External model services and separately downloaded tools remain subject to their own terms.
