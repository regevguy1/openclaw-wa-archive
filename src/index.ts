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

  // 4. Register message hooks
  // Use registerHook for reliable hook delivery across all OpenClaw versions.
  // Legacy api.on is mapped to noopOn in newer gateway versions (2026.5.7+),
  // so registerHook is the only reliable path for inbound message capture.
  api.registerHook?.('message_received', handleMessageReceived, {
    name: 'wa-archive:message-received',
    description: 'Archive inbound messages',
  });
  api.registerHook?.('message_sent', handleMessageSent, {
    name: 'wa-archive:message-sent',
    description: 'Archive outbound messages (legacy event)',
  });
  api.registerHook?.('message_preprocessed', handleMessagePreprocessed, {
    name: 'wa-archive:message-preprocessed',
    description: 'Archive messages during preprocessing',
  });

  // Plugin hooks (reliable — fires for ALL outbound including regular agent replies)
  api.registerHook?.('message_sending', handleMessageSending, {
    name: 'wa-archive:message-sending',
    description: 'Archive outbound messages before delivery',
  });

  // Fallback: reply_dispatch fires when gateway dispatches a reply (safety net)
  api.registerHook?.('reply_dispatch', handleReplyDispatch, {
    name: 'wa-archive:reply-dispatch',
    description: 'Fallback capture for outbound messages via reply dispatch',
  });

  // LLM output hook for token usage / cost tracking
  api.registerHook?.('llm_output', handleLlmOutput, {
    name: 'wa-archive:llm-output',
    description: 'Track token usage and costs per LLM call',
  });

  // 5. Register tools
  const allowFrom = config.allowFrom || [];

  api.registerTool(buildWaSearchTool(allowFrom));
  api.registerTool(buildWaStatsTool(allowFrom));

  // 6. Register backfill command
  api.registerCommand?.({
    name: 'wa-backfill',
    description: 'Import existing JSONL session transcripts into the WhatsApp archive',
    execute: async () => {
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
