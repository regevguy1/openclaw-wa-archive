# openclaw-wa-archive

OpenClaw plugin that archives **all** WhatsApp messages (inbound + outbound) into a SQLite database with full-text search (FTS5) and semantic/vector search (sqlite-vec + OpenAI embeddings).

## Features

- 📥 **Auto-archive** — hooks into WhatsApp message events, stores every message automatically
- 🔍 **Full-text search** — FTS5 for fast keyword search across all conversations
- 🧠 **Semantic search** — OpenAI embeddings + sqlite-vec for meaning-based search
- 🔀 **Hybrid search** — combines FTS + semantic for best results (default mode)
- 📊 **Stats tool** — message counts, per-chat/sender breakdowns, busiest hours
- 📎 **Media download** — saves images, videos, audio, documents locally
- 🔄 **Backfill** — import existing JSONL session transcripts from OpenClaw history
- 🔐 **Access control** — restrict search tools to specific phone numbers

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/regevguy1/openclaw-wa-archive.git
cd openclaw-wa-archive
npm install
npm run build
```

### 2. Configure OpenClaw

Add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-wa-archive"  // absolute path to the cloned repo
      ]
    },
    "entries": {
      "wa-archive": {
        "enabled": true,
        "config": {
          "dataDir": "~/.openclaw/data/wa-archive",
          "enableEmbeddings": true,
          "mediaDownload": true,
          "allowFrom": ["+972XXXXXXXXX"]  // phone numbers allowed to use search tools
        }
      }
    }
  }
}
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

The plugin will create the database and start archiving messages immediately.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataDir` | string | `~/.openclaw/data/wa-archive` | Directory for SQLite DB and media files |
| `enableEmbeddings` | boolean | `true` | Enable semantic search via OpenAI embeddings |
| `embeddingModel` | string | `text-embedding-3-small` | OpenAI embedding model (1536 dimensions) |
| `mediaDownload` | boolean | `true` | Download and store media files locally |
| `allowFrom` | string[] | `[]` | Phone numbers allowed to use wa_search and wa_stats tools |

### Environment Variables

- `OPENAI_API_KEY` — Required for embeddings. The plugin reads this from the environment.

## Tools

### `wa_search`

Search the WhatsApp message archive. Supports full-text, semantic, or hybrid search.

**Parameters:**
- `query` (string, required) — Search query (natural language or keywords)
- `sender` (string) — Filter by sender name or phone number
- `chat` (string) — Filter by chat/group name or ID
- `chat_type` (string) — `"group"` or `"direct"`
- `from_date` (string) — Start date (ISO 8601 or relative: `"2 days ago"`, `"yesterday"`, `"last week"`)
- `to_date` (string) — End date
- `mode` (string) — `"fts"` (full-text), `"semantic"` (vector), `"hybrid"` (both, default)
- `limit` (number) — Max results (default: 20)

### `wa_stats`

Get statistics about the WhatsApp message archive.

**Parameters:**
- `period` (string) — `"today"`, `"week"`, `"month"`, `"all"` (default: `"week"`)
- `chat` (string) — Filter by specific chat name or ID
- `sender` (string) — Filter by specific sender

**Returns:** Total messages, per-chat breakdown, per-sender breakdown, busiest hours, inbound/outbound ratio.

## Public X/Twitter Companion Workflow

Use this plugin for private WhatsApp archive search, stats, media, and backfill.
Add [TweetClaw](https://github.com/Xquik-dev/tweetclaw) when the same OpenClaw
gateway also needs public X/Twitter context through the
[@xquik/tweetclaw](https://www.npmjs.com/package/@xquik/tweetclaw) plugin.

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Typical archive handoffs:

- Compare private WhatsApp questions with public tweet search or reply search.
- Attach tweet URLs or tweet IDs to follow-up notes while private chat data stays in wa-archive.
- Search tweets, user timelines, followers, and media before posting reviewed tweet replies from OpenClaw.
- Post tweets or post tweet replies only after the agent has reviewed the private archive context and public X/Twitter context separately.

Keep Xquik API keys in local OpenClaw config or environment variables. Do not
paste them into chat messages, archive rows, media metadata, or backfill
transcripts.

## Backfill — Importing Historical Messages

The plugin can import existing WhatsApp messages from OpenClaw's JSONL session transcripts.

### Automatic (via OpenClaw command)

```
/wa-backfill
```

### How backfill works

1. Scans `~/.openclaw/agents/main/sessions/*.jsonl`
2. Reads `sessions.json` to map session IDs → session keys (which contain chat metadata)
3. Parses each JSONL file line by line:
   - **User messages** (role: `user`) → stored as inbound
   - **Assistant messages** with `message` tool calls (action: `send`) → stored as outbound
   - Direct assistant text replies → stored as outbound
   - `NO_REPLY` and `HEARTBEAT_OK` messages are skipped
4. Session keys encode chat info: `agent:main:whatsapp:group:120363...@g.us` or `agent:main:whatsapp:direct:+972...`
5. Inserts are idempotent (`INSERT OR IGNORE`) — safe to run multiple times
6. After import, queues embedding generation for all new messages

### Batch Embedding Script

If you need to (re-)embed all messages (e.g., after backfill or if embeddings were disabled):

```bash
OPENAI_API_KEY=sk-... node scripts/batch-embed.js
```

This script:
- Finds all messages without embeddings
- Processes in batches of 50
- Rate limits with 1s delay between batches
- Handles 429 rate limits with exponential backoff
- Strips metadata envelope from content for cleaner embeddings
- Reports progress as it goes

**Cost:** ~$0.01 for 2,500 messages with `text-embedding-3-small`.

## Database

SQLite database at `{dataDir}/messages.db` with:

- **`messages`** table — all message data (id, chat, sender, content, timestamps, media paths, etc.)
- **`messages_fts`** — FTS5 virtual table for full-text search (auto-synced via triggers)
- **`messages_vec`** — sqlite-vec virtual table for vector similarity search (1536-dim float embeddings)

### Schema highlights

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_key TEXT,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,        -- 'group' or 'direct'
  chat_name TEXT,
  sender_id TEXT,
  sender_name TEXT,
  timestamp INTEGER NOT NULL,     -- Unix ms
  content TEXT,
  media_local_path TEXT,
  media_type TEXT,
  is_from_me INTEGER DEFAULT 0,
  direction TEXT DEFAULT 'inbound',
  channel TEXT DEFAULT 'whatsapp',
  account_id TEXT,
  metadata TEXT                   -- JSON blob
);
```

SQLite is in WAL mode for concurrent read performance.

## Architecture

```
openclaw-wa-archive/
├── openclaw.plugin.json    # Plugin manifest
├── package.json
├── tsconfig.json
├── scripts/
│   └── batch-embed.js      # Standalone batch embedding script
├── src/
│   ├── index.ts             # Plugin entry — register() hooks, tools, commands
│   ├── db.ts                # SQLite setup, migrations, helpers
│   ├── ingest.ts            # Message event → DB row
│   ├── embeddings.ts        # OpenAI embedding generation (async, batched)
│   ├── media.ts             # Media download + local storage
│   ├── backfill.ts          # JSONL transcript → DB import
│   └── tools/
│       ├── wa-search.ts     # wa_search tool
│       └── wa-stats.ts      # wa_stats tool
└── data/                    # Created at runtime (gitignored)
    ├── messages.db          # SQLite database
    └── media/               # Downloaded media files
```

## Important Notes

- **Graceful degradation** — If sqlite-vec fails to load, falls back to FTS-only search. If OpenAI API is unavailable, skips embeddings but still stores messages.
- **Non-blocking** — Embedding generation and media downloads happen asynchronously, never block message processing.
- **Idempotent** — All inserts use `INSERT OR IGNORE`. Safe to re-run backfill.
- **Performance** — WAL mode, batched inserts, indexed on chat_id, sender_id, timestamp.
- **Access control** — Tools check sender against `allowFrom` config. Only listed phone numbers can search.

## Troubleshooting

### Embeddings not working
- Check `OPENAI_API_KEY` is set in environment
- Verify without printing the key: `test -n "$OPENAI_API_KEY" && echo "OPENAI_API_KEY is set"`
- Run `node scripts/batch-embed.js` manually to see errors

### sqlite-vec not loading
- Ensure `npm install` completed (installs `sqlite-vec` and `better-sqlite3`)
- On some platforms, `better-sqlite3` needs native compilation: `npm rebuild better-sqlite3`

### No messages appearing
- Check OpenClaw logs for `[wa-archive] Plugin loaded successfully`
- Verify the plugin path in `openclaw.json` is correct
- Ensure `wa-archive` is in `plugins.entries` with `enabled: true`

## License

MIT
