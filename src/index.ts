import path from 'path';
import { initDb, closeDb } from './db';
import { configureEmbeddings } from './embeddings';
import { configureMedia } from './media';
import { handleMessageReceived, handleMessageSent, handleMessagePreprocessed, handleMessageSending, handleReplyDispatch, setOutboundSenderName } from './ingest';
import { buildWaSearchTool } from './tools/wa-search';
import { buildWaStatsTool } from './tools/wa-stats';
import { runBackfill, setBackfillSenderName } from './backfill';
import { handleLlmOutput } from './costs';

export function register(api: any) {
  const config = api.getConfig?.() || {};
  const dataDir = config.dataDir
    ? config.dataDir.replace('~', process.env.HOME || '')
    : path.join(process.env.HOME || '', '.openclaw', 'data', 'wa-archive');

  // 1. Initialize database
  try {
    initDb(dataDir);
  } catch (err) {
    console.error('[wa-archive] Failed to initialize database:', err);
    return;
  }

  // 2. Configure embeddings
  const enableEmbeddings = config.enableEmbeddings !== false;
  configureEmbeddings({
    apiKey: config.openaiApiKey || process.env.OPENAI_API_KEY,
    model: config.embeddingModel || 'text-embedding-3-small',
    enabled: enableEmbeddings,
  });

  // 2b. Configure outbound sender name
  const botName = config.botName || config.agentName || 'Me';
  setOutboundSenderName(botName);
  setBackfillSenderName(botName);

  // 3. Configure media
  if (config.mediaDownload !== false) {
    configureMedia(dataDir);
  }

  // 4. Register message hooks — version-adaptive.
  //
  // OpenClaw has TWO hook registration systems that changed between versions:
  //   - api.on()           → typedHooks registry (dispatched by hook runner) — works in ≤2026.4.x
  //   - api.registerHook() → internal hooks system — works in ≤2026.4.x but NOT dispatched for messages
  //
  // In 2026.5.7+, api.on() is mapped to noopOn, and registerHook becomes the correct path
  // for typed hook dispatch.
  //
  // We detect at runtime: try a test registration with api.on(), check if it populates
  // typedHooks (via hasHooks on hookRunner), and fall back accordingly.
  //
  // Bug history:
  //   2026-05-18: Switched to registerHook (advice from Chloe on 2026.5.7) → broke on 2026.4.22
  //   2026-05-24: Fixed with version-adaptive approach.

  const hooks: Array<[string, Function]> = [
    ['message_received', handleMessageReceived],
    ['message_sent', handleMessageSent],
    ['message_preprocessed', handleMessagePreprocessed],
    ['message_sending', handleMessageSending],
    ['reply_dispatch', handleReplyDispatch],
    ['llm_output', handleLlmOutput],
  ];

  // Detect which registration path works.
  // api.on() in ≤2026.4.x maps to registerTypedHook (correct).
  // api.on() in ≥2026.5.7 maps to noopOn (broken).
  // We check: if api.on is named 'noopOn' or has length 0 (noop signature), use registerHook.
  const onFn = api.on;
  const onIsNoop = !onFn || onFn === Function.prototype || onFn.name === 'noopOn' || onFn.name === 'noop';

  if (onIsNoop && api.registerHook) {
    // Newer gateway (≥2026.5.7): api.on is noop, use registerHook
    console.log('[wa-archive] Using registerHook (api.on is noop — gateway ≥2026.5.7)');
    for (const [event, handler] of hooks) {
      api.registerHook(event, handler, {
        name: `wa-archive:${event}`,
        description: `wa-archive: ${event}`,
      });
    }
  } else if (onFn) {
    // Older gateway (≤2026.4.x): api.on maps to registerTypedHook
    console.log('[wa-archive] Using api.on (gateway ≤2026.4.x)');
    for (const [event, handler] of hooks) {
      api.on(event, handler);
    }
  } else {
    console.error('[wa-archive] No hook registration method available! Messages will NOT be archived.');
  }

  // 5. Register tools
  const allowFrom = config.allowFrom || [];

  api.registerTool(buildWaSearchTool(allowFrom));
  api.registerTool(buildWaStatsTool(allowFrom));

  // 6. Register backfill command
  api.registerCommand?.({
    name: 'wa-backfill',
    description: 'Import existing JSONL session transcripts into the WhatsApp archive',
    handler: async () => {
      console.log('[wa-archive] Starting backfill...');
      const result = await runBackfill();
      return `Backfill complete: ${result.imported} imported, ${result.skipped} skipped`;
    },
  });

  // 7. Register cleanup on shutdown
  api.registerHook?.('shutdown', () => {
    closeDb();
  }, {
    name: 'wa-archive:shutdown',
  });

  console.log('[wa-archive] Plugin loaded successfully');
}
