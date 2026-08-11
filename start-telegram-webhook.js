#!/usr/bin/env node

/**
 * Telegram Webhook Server
 * Starts the Telegram webhook server for receiving messages
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const Logger = require('./src/core/logger');
const TelegramWebhookHandler = require('./src/channels/telegram/webhook');

// Load environment variables
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const logger = new Logger('Telegram-Webhook-Server');

function parseSessionAliases(value = '') {
    const aliases = {};
    for (const entry of value.split(',')) {
        const separator = entry.indexOf(':');
        if (separator === -1) continue;
        const alias = entry.slice(0, separator).trim();
        const session = entry.slice(separator + 1).trim();
        if (/^\d+$/.test(alias) && session) aliases[alias] = session;
    }
    return aliases;
}

function loadSessionAliases(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return {};
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const aliases = {};
        for (const [alias, session] of Object.entries(parsed)) {
            if (/^\d+$/.test(alias) && typeof session === 'string' && session) {
                aliases[alias] = session;
            }
        }
        return aliases;
    } catch (error) {
        logger.warn(`Could not load saved session aliases: ${error.message}`);
        return {};
    }
}

const sessionDataDir = process.env.SESSION_DATA_DIR || path.join(__dirname, 'data/sessions');
const sessionAliasesFile = process.env.TELEGRAM_SESSION_ALIASES_FILE ||
    path.join(path.dirname(sessionDataDir), 'session-aliases.json');
const selectedSessionsFile = process.env.TELEGRAM_SELECTED_SESSIONS_FILE ||
    path.join(path.dirname(sessionDataDir), 'selected-sessions.json');
const panelAnchorsFile = process.env.TELEGRAM_PANEL_ANCHORS_FILE ||
    path.join(path.dirname(sessionDataDir), 'panel-anchors.json');
// Shared with the notify hook, which writes the suggestions this reads.
const suggestionsFile = process.env.TELEGRAM_SUGGESTIONS_FILE ||
    path.join(path.dirname(sessionDataDir), 'reply-suggestions.json');

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const MODE_ALIASES = { ask: 'default', edits: 'acceptEdits', plan: 'plan', auto: 'auto' };

function parseDefaultMode(value) {
    if (!value) return 'auto';
    const requested = MODE_ALIASES[value.trim().toLowerCase()] || value.trim();
    if (PERMISSION_MODES.includes(requested)) return requested;
    logger.warn(`Ignoring unknown CLAUDIO_DEFAULT_MODE '${value}'; using auto`);
    return 'auto';
}
const configuredAliases = parseSessionAliases(process.env.TELEGRAM_SESSION_ALIASES);
const savedAliases = loadSessionAliases(sessionAliasesFile);

// Load configuration
const config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    groupId: process.env.TELEGRAM_GROUP_ID,
    whitelist: process.env.TELEGRAM_WHITELIST ? process.env.TELEGRAM_WHITELIST.split(',').map(id => id.trim()) : [],
    port: process.env.TELEGRAM_WEBHOOK_PORT || 3001,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowTokenlessCommands: process.env.TELEGRAM_ALLOW_TOKENLESS_COMMANDS === 'true',
    defaultSession: process.env.TELEGRAM_DEFAULT_SESSION || 'claudio',
    sessionAliases: { ...configuredAliases, ...savedAliases },
    sessionAliasesFile,
    selectedSessionsFile,
    panelAnchorsFile,
    suggestionsFile,
    // Sessions opened from the phone start here. Auto is the default because a
    // remote session with nobody at the keyboard spends its time waiting for
    // permission answers otherwise.
    defaultMode: parseDefaultMode(process.env.CLAUDIO_DEFAULT_MODE),
    projectsRoot: process.env.CLAUDIO_PROJECTS_ROOT || path.join(process.env.HOME || process.cwd(), 'Projects'),
    claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude'
};

// Validate configuration
if (!config.botToken) {
    logger.error('TELEGRAM_BOT_TOKEN must be set in .env file');
    process.exit(1);
}

if (!config.chatId && !config.groupId) {
    logger.error('Either TELEGRAM_CHAT_ID or TELEGRAM_GROUP_ID must be set in .env file');
    process.exit(1);
}

if (config.webhookUrl && !config.webhookSecret) {
    logger.error('TELEGRAM_WEBHOOK_SECRET must be set when TELEGRAM_WEBHOOK_URL is configured');
    process.exit(1);
}

// Create and start webhook handler
const webhookHandler = new TelegramWebhookHandler(config);

async function start() {
    logger.info('Starting Telegram webhook server...');
    logger.info(`Configuration:`);
    logger.info(`- Port: ${config.port}`);
    logger.info(`- Chat ID: ${config.chatId || 'Not set'}`);
    logger.info(`- Group ID: ${config.groupId || 'Not set'}`);
    logger.info(`- Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(', ') : 'None (using configured IDs)'}`);
    logger.info(`- Personal shortcuts: ${config.allowTokenlessCommands ? 'Enabled' : 'Disabled'}`);
    logger.info(`- Default session: ${config.defaultSession}`);
    logger.info(`- Session aliases: ${Object.keys(config.sessionAliases).length > 0 ? Object.entries(config.sessionAliases).map(([alias, session]) => `${alias}:${session}`).join(', ') : 'None'}`);
    logger.info(`- Projects root: ${config.projectsRoot}`);
    logger.info(`- Default permission mode: ${config.defaultMode}`);

    // Start accepting requests before the Telegram API registration call. This
    // keeps the health endpoint and an already-registered webhook available if
    // Telegram is temporarily slow or unreachable during process startup.
    webhookHandler.start(config.port);
    
    // Set webhook if URL is provided
    if (config.webhookUrl) {
        try {
            const webhookEndpoint = `${config.webhookUrl}/webhook/telegram`;
            logger.info(`Setting webhook to: ${webhookEndpoint}`);
            await webhookHandler.setWebhook(webhookEndpoint);
        } catch (error) {
            logger.error('Failed to set webhook:', error.message);
            logger.info('Use Telegram Bot API setWebhook with the configured URL and secret token.');
        }
    } else {
        logger.warn('TELEGRAM_WEBHOOK_URL not set. Please set the webhook manually.');
        logger.info('Set TELEGRAM_WEBHOOK_URL and restart to register it automatically.');
    }

    try {
        await webhookHandler.setBotCommands();
    } catch (error) {
        logger.warn('Telegram command menu could not be updated; inline controls remain available.');
    }
    
}

start();

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down Telegram webhook server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down Telegram webhook server...');
    process.exit(0);
});
