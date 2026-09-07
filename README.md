# Aboki Agent

Aboki Agent is a customizable Eliza-style AI runtime built on `@elizaos/core` with Solana trading intelligence, adaptive token scoring, and support for multiple client connectors.

## What this project does

- Starts an Eliza-based agent runtime using `src/index.ts`
- Loads a default character configuration from `src/aboki.character.ts`
- Runs the Aboki trading loop in `src/plugins/aboki-trader.ts`
- Scans DexScreener for Solana tokens and scores them using Groq AI
- Tracks whale activity, journal entries, and watchlist state
- Supports custom clients for `direct`, `telegram`, `discord`, `twitter`, and `auto`

## Requirements

- Node.js 22 or later
- `pnpm`

## Install

```bash
pnpm install
```

## Configure environment variables

Copy the example environment template:

```bash
cp .env.example .env
```

Then populate `.env` with your keys and runtime settings.

### Common configuration values

- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `DISCORD_API_TOKEN`
- `TWITTER_USERNAME`
- `TWITTER_PASSWORD`
- `TWITTER_EMAIL`
- `WALLET_PUBLIC_KEY`
- `WALLET_PRIVATE_KEY`
- `RPC_URL`
- `HELIUS_API_KEY`
- `SERVER_PORT`
- `DAEMON_PROCESS`

The provided `.env.example` also includes options for ElevenLabs, OLLAMA, Heurist, DeepSeek, and other providers.

## Run the agent

```bash
pnpm start
```

By default, the repository starts the direct client runtime and an interactive CLI chat loop unless `DAEMON_PROCESS=true`.

## Custom characters

The default character is defined in `src/aboki.character.ts` and a sample JSON character is available at `characters/eliza.character.json`.

Load a custom character JSON file using:

```bash
pnpm start --character="characters/eliza.character.json"
```

Load multiple characters using:

```bash
pnpm start --characters="characters.eliza.character.json,characters/another.character.json"
```

Character JSON may define:
- `name`
- `clients`
- `modelProvider`
- `settings.secrets`
- `system`
- `bio`, `lore`, `messageExamples`, `postExamples`

## Docker

### Docker Compose

Update `docker-compose.yaml` with your environment values, then run:

```bash
docker compose up
```

This compose file mounts `./data` so runtime persistence is preserved.

### Build for `linux/amd64`

```bash
docker buildx build --platform linux/amd64 -t aboki-agent:v1 --load .
```

Then run with:

```bash
docker compose -f docker-compose-image.yaml up
```

## Development

Build the TypeScript package:

```bash
pnpm build
```

Clean generated output:

```bash
pnpm run clean
```

Start all services with PM2:

```bash
pnpm run start:service:all
```

Stop PM2 services:

```bash
pnpm run stop:service:all
```

## Notes

- The trading plugin scans for fresh Solana tokens, scores them using a Groq model, and logs decisions.
- `src/config/index.ts` handles CLI argument parsing and provider token resolution.
- `src/clients/index.ts` initializes supported clients based on each character's configuration.
- Runtime data is stored in `data/` and loaded at startup.

## License

This project is licensed under the terms in `LICENSE`.
