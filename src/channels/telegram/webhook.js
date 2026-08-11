/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');
const MessageAnchor = require('./message-anchor');
const { renderPanel, MODELS, EFFORTS, MODE_LABELS } = require('./panel-view');

// Telegram serves files up to 20MB through getFile; a screenshot that large is
// a mistake rather than a screenshot.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

class TelegramWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('TelegramWebhook');
        this.sessionsDir = process.env.SESSION_DATA_DIR || path.join(__dirname, '../../data/sessions');
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        this.selectedSessions = this._loadSelectedSessions();
        this.permissionPrompts = new Map();
        this.permissionState = new Map();
        this.permissionPollInterval = null;
        this.activeTelegramTasks = new Map();
        this.activityPollInterval = null;
        this.pendingSessionCreates = new Map();
        this.panelViews = new Map();
        this.panelStatus = new Map();
        this.panel = new MessageAnchor({
            filePath: this.config.panelAnchorsFile,
            logger: this.logger,
            send: (chatId, text, options) => this._sendMessage(chatId, text, options),
            edit: (chatId, messageId, text, options) => this._editMessageText(chatId, messageId, text, options),
            remove: (chatId, messageId) => this._deleteMessage(chatId, messageId)
        });
        this.uploadsFallbackDir = path.join(__dirname, '../../data/uploads');

        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware() {
        // Parse JSON for all requests
        this.app.use(express.json({ limit: '64kb' }));
    }

    _setupRoutes() {
        // Telegram webhook endpoint
        this.app.post(
            '/webhook/telegram',
            this._verifyTelegramSecret.bind(this),
            this._handleWebhook.bind(this)
        );

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'telegram-webhook' });
        });
    }

    _verifyTelegramSecret(req, res, next) {
        if (!this.config.webhookSecret) {
            return res.status(503).send('Webhook secret is not configured');
        }

        const supplied = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
        const expected = String(this.config.webhookSecret);
        const suppliedBuffer = Buffer.from(supplied);
        const expectedBuffer = Buffer.from(expected);

        if (
            suppliedBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
        ) {
            this.logger.warn('Rejected webhook request with invalid secret');
            return res.status(401).send('Unauthorized');
        }

        next();
    }

    /**
     * Generate network options for axios requests
     * @returns {Object} Network options object
     */
    _getNetworkOptions() {
        const options = { timeout: 10000 };
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    async _handleWebhook(req, res) {
        try {
            const update = req.body;
            
            // Handle different update types
            if (update.message) {
                await this._handleMessage(update.message);
            } else if (update.callback_query) {
                await this._handleCallbackQuery(update.callback_query);
            }
            
            res.status(200).send('OK');
        } catch (error) {
            this.logger.error('Webhook handling error:', error.message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleMessage(message) {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const messageText = message.text?.trim();

        // Authorization comes before the shape of the message: the check used to
        // sit behind an early return for anything without text, so an image from
        // an unknown chat was dropped as silently as one from the operator.
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

        if (this._imageFrom(message)) {
            await this._handleImageMessage(message);
            return;
        }

        if (!messageText) return;

        // Handle /start command
        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }

        // Handle /help command
        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }

        if (messageText === '/new') {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._sendNewSessionHelp(chatId);
            return;
        }

        if (messageText === '/panel') {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            // Typed, so the operator is looking at the bottom of the chat: the
            // panel moves down to meet them instead of updating out of sight.
            await this._sendControlPanel(chatId, '', { relocate: true });
            return;
        }

        const submenuCommands = {
            '/model': 'model',
            '/effort': 'effort',
            '/session': 'session',
            '/mode': 'mode'
        };
        if (submenuCommands[messageText]) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._sendControlSubmenu(chatId, submenuCommands[messageText], { relocate: true });
            return;
        }

        const directModel = messageText.match(/^\/model\s+(sonnet|opus|haiku)$/i);
        if (directModel) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const model = directModel[1].toLowerCase();
            await this._runPanelCommand(chatId, `/model ${model}`, 'model', model, { relocate: true });
            return;
        }

        const directEffort = messageText.match(/^\/effort\s+(auto|low|medium|high|xhigh|max)$/i);
        if (directEffort) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const effort = directEffort[1].toLowerCase();
            await this._runPanelCommand(chatId, `/effort ${effort}`, 'effort', `effort ${effort}`, { relocate: true });
            return;
        }

        const directSession = messageText.match(/^\/session\s+(default|\d+)$/i);
        if (directSession) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._selectPanelSession(chatId, directSession[1].toLowerCase(), { relocate: true });
            return;
        }

        const directMode = messageText.match(/^\/mode\s+(ask|edits|plan|auto)$/i);
        if (directMode) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const modes = { ask: 'default', edits: 'acceptEdits', plan: 'plan', auto: 'auto' };
            await this._setPanelMode(chatId, modes[directMode[1].toLowerCase()], { relocate: true });
            return;
        }

        const newSession = messageText.match(/^\/new\s+(\d{1,4})\s+(.+)$/s);
        if (newSession) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._createProjectSession(chatId, newSession[1], newSession[2].trim());
            return;
        }

        // Existing token form remains available for multi-session/group usage.
        const tokenCommand = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (tokenCommand) {
            await this._processCommand(chatId, tokenCommand[1].toUpperCase(), tokenCommand[2]);
            return;
        }

        // Personal-chat numeric aliases, for example: "12 review the diff".
        const aliasCommand = messageText.match(/^(\d+)\s+(.+)$/s);
        if (aliasCommand && this.config.sessionAliases?.[aliasCommand[1]]) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._processSessionCommand(
                chatId,
                this.config.sessionAliases[aliasCommand[1]],
                aliasCommand[2],
                `alias ${aliasCommand[1]}`
            );
            return;
        }

        // Backward-compatible bare token form: "ABC12345 review the diff".
        const bareTokenCommand = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/s);
        if (bareTokenCommand) {
            await this._processCommand(chatId, bareTokenCommand[1].toUpperCase(), bareTokenCommand[2]);
            return;
        }

        // Personal-chat selected session: "/cmd review" or simply "review".
        // Plain text is how the panel is used almost every time, so it reads the
        // same selection the buttons do; `_getPanelSession` falls back to the
        // default when nothing has been selected.
        const defaultCommand = messageText.match(/^\/cmd\s+(.+)$/s)?.[1] ||
            (!messageText.startsWith('/') ? messageText : null);
        if (defaultCommand) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._processSessionCommand(
                chatId,
                this._getPanelSession(chatId),
                defaultCommand,
                'selected'
            );
            return;
        }

        await this._sendHelpMessage(chatId);
    }

    /**
     * The image in a message, if there is one.
     *
     * Photos arrive as a ladder of sizes and the last entry is the largest, which
     * is the only one worth reading. A screenshot sent as a file arrives as a
     * document instead, with the same content and no `photo` array at all.
     */
    _imageFrom(message) {
        if (Array.isArray(message.photo) && message.photo.length > 0) {
            const largest = message.photo[message.photo.length - 1];
            return { fileId: largest.file_id, fileSize: largest.file_size, name: null };
        }
        const document = message.document;
        if (document && typeof document.mime_type === 'string' && document.mime_type.startsWith('image/')) {
            return { fileId: document.file_id, fileSize: document.file_size, name: document.file_name };
        }
        return null;
    }

    async _handleImageMessage(message) {
        const chatId = message.chat.id;
        if (!this._canUseTokenlessCommands(chatId)) {
            await this._sendTokenRequiredMessage(chatId);
            return;
        }

        const image = this._imageFrom(message);
        const session = this._getPanelSession(chatId);
        let savedPath;
        try {
            savedPath = await this._saveImageForSession(image, session);
        } catch (error) {
            this.logger.error('Image download failed:', error.message);
            await this._sendMessage(chatId, `❌ Could not save the image: ${error.message}`);
            return;
        }

        // Claude reads images from disk, so what travels through tmux is the
        // path. The caption is the instruction when there is one.
        const caption = message.caption?.trim();
        const prompt = caption ? `${caption}\n${savedPath}` : `Look at this image: ${savedPath}`;
        const result = await this._processSessionCommand(chatId, session, prompt, 'image');
        if (result.ok) {
            await this._renderPanel(chatId, { status: `🖼 ${path.basename(savedPath)}` });
        }
    }

    async _saveImageForSession(image, session) {
        if (image.fileSize && image.fileSize > MAX_IMAGE_BYTES) {
            throw new Error(`image is larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB`);
        }

        const file = await this._downloadTelegramFile(image.fileId);
        const extension = (path.extname(image.name || '') || path.extname(file.remoteName) || '.jpg')
            .toLowerCase()
            .replace(/[^.a-z0-9]/g, '');
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
        const name = `${stamp}-${crypto.randomBytes(2).toString('hex')}${extension || '.jpg'}`;
        const directory = this._uploadDirectory(session);
        const target = path.join(directory, name);
        fs.writeFileSync(target, file.buffer, { mode: 0o600 });
        this.logger.info(`Image saved for session '${session}': ${target}`);
        return target;
    }

    /**
     * Uploads land next to the code the session is working on, because a path
     * inside the working directory is one Claude can read without asking. The
     * folder ignores itself so it never shows up in the project's git status.
     */
    _uploadDirectory(session) {
        const info = this.injector.getSessionInfo(session);
        const base = info.cwd && fs.existsSync(info.cwd) ? info.cwd : this.uploadsFallbackDir;
        const directory = path.join(base, '.claudio-uploads');
        fs.mkdirSync(directory, { recursive: true });
        const ignore = path.join(directory, '.gitignore');
        if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
        return directory;
    }

    async _downloadTelegramFile(fileId) {
        const lookup = await axios.get(
            `${this.apiBaseUrl}/bot${this.config.botToken}/getFile`,
            { ...this._getNetworkOptions(), params: { file_id: fileId } }
        );
        const remotePath = lookup.data?.result?.file_path;
        if (!remotePath) throw new Error('Telegram returned no file path');
        if (lookup.data.result.file_size > MAX_IMAGE_BYTES) {
            throw new Error(`image is larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB`);
        }

        const download = await axios.get(
            `${this.apiBaseUrl}/file/bot${this.config.botToken}/${remotePath}`,
            {
                ...this._getNetworkOptions(),
                // A photo is bigger than an API reply, and both limits here are
                // about not hanging on a slow phone upload.
                timeout: 30000,
                maxContentLength: MAX_IMAGE_BYTES,
                responseType: 'arraybuffer'
            }
        );
        return { buffer: Buffer.from(download.data), remoteName: path.basename(remotePath) };
    }

    _canUseTokenlessCommands(chatId) {
        return this.config.allowTokenlessCommands === true &&
            Boolean(this.config.chatId) &&
            String(chatId) === String(this.config.chatId);
    }

    async _sendTokenRequiredMessage(chatId) {
        await this._sendMessage(
            chatId,
            '❌ This chat requires a notification token. Use /cmd <TOKEN> <command>.'
        );
    }

    async _processSessionCommand(chatId, sessionName, command, routeLabel) {
        // Panel routes report through the panel's own status line, so they must
        // not also post a message of their own -- that was half the pile-up.
        const isPanelRoute = routeLabel.startsWith('panel ');
        try {
            await this.injector.injectCommand(command, sessionName);
            if (!isPanelRoute) {
                await this._markTelegramTaskActive(chatId, sessionName);
            }
            this.logger.info(`Command injected - User: ${chatId}, Session: ${sessionName}, Route: ${routeLabel}, Command: ${command}`);
            return { ok: true };
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            if (!isPanelRoute) {
                await this._sendMessage(chatId, `❌ Command execution failed: ${error.message}`);
            }
            return { ok: false, error: error.message };
        }
    }

    async _processCommand(chatId, token, command) {
        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._sendMessage(chatId, 
                '❌ Invalid or expired token. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId, 
                '❌ Token has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);
            await this._markTelegramTaskActive(chatId, tmuxSession);
            
            // Send confirmation
            await this._sendMessage(chatId, 
                `✅ *Command sent successfully*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                { parse_mode: 'Markdown' });
            
            // Log command execution
            this.logger.info(`Command injected - User: ${chatId}, Token: ${token}, Command: ${command}`);
            
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId, 
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const userId = callbackQuery.from.id;
        const data = callbackQuery.data;

        if (!this._isAuthorized(userId, chatId)) {
            await this._answerCallbackQuery(callbackQuery.id, 'Not authorized');
            return;
        }

        if (data.startsWith('perm:')) {
            await this._handlePermissionCallback(callbackQuery);
            return;
        }

        if (data.startsWith('new:')) {
            await this._handleNewSessionCallback(callbackQuery);
            return;
        }

        if (data.startsWith('ctl:')) {
            await this._handleControlCallback(callbackQuery);
            return;
        }

        // Answer callback query to remove loading state
        await this._answerCallbackQuery(callbackQuery.id);

        if (data.startsWith('personal:')) {
            const token = data.split(':')[1];
            // Send personal chat command format
            await this._sendMessage(chatId,
                `📝 *Personal Chat Command Format:*\n\n\`/cmd ${token} <your command>\`\n\n*Example:*\n\`/cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('group:')) {
            const token = data.split(':')[1];
            // Send group chat command format with @bot_name
            const botUsername = await this._getBotUsername();
            await this._sendMessage(chatId,
                `👥 *Group Chat Command Format:*\n\n\`@${botUsername} /cmd ${token} <your command>\`\n\n*Example:*\n\`@${botUsername} /cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('session:')) {
            const token = data.split(':')[1];
            // For backward compatibility - send help message for old callback buttons
            await this._sendMessage(chatId,
                `📝 *How to send a command:*\n\nType:\n\`/cmd ${token} <your command>\`\n\nExample:\n\`/cmd ${token} please analyze this code\`\n\n💡 *Tip:* New notifications have a button that auto-fills the command for you!`,
                { parse_mode: 'Markdown' });
        }
    }

    _getPanelSession(chatId) {
        return this.selectedSessions.get(String(chatId)) || this.config.defaultSession;
    }

    _loadSelectedSessions() {
        try {
            const filePath = this.config.selectedSessionsFile;
            if (!filePath || !fs.existsSync(filePath)) return new Map();
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return new Map(
                Object.entries(parsed)
                    .filter(([chatId, session]) => /^-?\d+$/.test(chatId) && typeof session === 'string' && session)
            );
        } catch (error) {
            this.logger.warn(`Could not load selected sessions: ${error.message}`);
            return new Map();
        }
    }

    _persistSelectedSessions() {
        const filePath = this.config.selectedSessionsFile;
        if (!filePath) return;

        const directory = path.dirname(filePath);
        const temporary = `${filePath}.${process.pid}.tmp`;
        const selected = Object.fromEntries(this.selectedSessions);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporary, `${JSON.stringify(selected, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    }

    _getSessionDisplayName(session) {
        const aliasEntry = Object.entries(this.config.sessionAliases || {})
            .find(([, mappedSession]) => mappedSession === session);
        const alias = aliasEntry?.[0];
        const info = this.injector.getSessionInfo(session);
        let folder = info.cwd ? path.basename(info.cwd) : '';
        if (!folder && alias) {
            const prefix = `claudio-${alias}-`;
            if (session.startsWith(prefix)) folder = session.slice(prefix.length);
        }
        if (!folder) folder = session === this.config.defaultSession ? 'Projects' : session;
        return alias ? `${alias} · ${folder}` : `Default · ${folder}`;
    }

    async _handleControlCallback(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;

        if (!this._canUseTokenlessCommands(chatId)) {
            await this._answerCallbackQuery(callbackQuery.id, 'Not authorized');
            return;
        }

        // A Controls button on a notification is not the panel, so it opens one
        // at the bottom of the chat rather than editing a bubble further up.
        if (data === 'ctl:panel') {
            await this._answerCallbackQuery(callbackQuery.id);
            await this._sendControlPanel(chatId, '', { relocate: true });
            return;
        }

        // Every other control is on the panel itself: the message that carried
        // the button is the message that keeps being edited, even if the stored
        // anchor was lost in between.
        this.panel.adopt(chatId, callbackQuery.message.message_id);

        if (data.startsWith('ctl:v:')) {
            await this._answerCallbackQuery(callbackQuery.id);
            await this._sendControlSubmenu(chatId, data.slice('ctl:v:'.length));
            return;
        }

        if (data === 'ctl:new') {
            await this._answerCallbackQuery(callbackQuery.id);
            await this._sendNewSessionHelp(chatId);
            return;
        }

        if (data.startsWith('ctl:s:')) {
            const selector = data.slice('ctl:s:'.length);
            const sessionName = await this._selectPanelSession(chatId, selector);
            await this._answerCallbackQuery(
                callbackQuery.id,
                sessionName ? `Session: ${selector}` : `Unknown session: ${selector}`
            );
            return;
        }

        if (data.startsWith('ctl:m:')) {
            const model = data.slice('ctl:m:'.length);
            if (!MODELS.includes(model)) {
                await this._answerCallbackQuery(callbackQuery.id, 'Invalid model');
                return;
            }
            const result = await this._runPanelCommand(chatId, `/model ${model}`, 'model', model);
            await this._answerToast(callbackQuery.id, result, `Model: ${model}`);
            return;
        }

        if (data.startsWith('ctl:e:')) {
            const effort = data.slice('ctl:e:'.length);
            if (!EFFORTS.includes(effort)) {
                await this._answerCallbackQuery(callbackQuery.id, 'Invalid effort');
                return;
            }
            const result = await this._runPanelCommand(chatId, `/effort ${effort}`, 'effort', `effort ${effort}`);
            await this._answerToast(callbackQuery.id, result, `Effort: ${effort}`);
            return;
        }

        if (data.startsWith('ctl:o:')) {
            const mode = data.slice('ctl:o:'.length);
            if (!MODE_LABELS[mode]) {
                await this._answerCallbackQuery(callbackQuery.id, 'Invalid mode');
                return;
            }
            const result = await this._setPanelMode(chatId, mode);
            await this._answerToast(callbackQuery.id, result, `Mode: ${MODE_LABELS[mode]}`);
            return;
        }

        if (data.startsWith('ctl:a:')) {
            const action = data.slice('ctl:a:'.length);
            const commands = { continue: 'continue', compact: '/compact' };
            if (action === 'stop') {
                const result = await this._runPanelKey(chatId, 'C-c', 'stop');
                await this._answerToast(callbackQuery.id, result, 'Stopped');
            } else if (action === 'status') {
                await this._answerCallbackQuery(callbackQuery.id);
                await this._showSessionStatus(chatId);
            } else if (commands[action]) {
                const result = await this._runPanelCommand(chatId, commands[action], action, action);
                await this._answerToast(callbackQuery.id, result, `Sent: ${action}`);
            } else {
                await this._answerCallbackQuery(callbackQuery.id);
            }
            return;
        }

        await this._answerCallbackQuery(callbackQuery.id);
    }

    async _answerToast(callbackQueryId, result, successText) {
        // Callback answers are capped at 200 characters by Telegram.
        const text = result.ok ? successText : `❌ ${result.error}`.slice(0, 190);
        await this._answerCallbackQuery(callbackQueryId, text);
    }

    async _selectPanelSession(chatId, selector, options = {}) {
        const sessionName = selector === 'default'
            ? this.config.defaultSession
            : this.config.sessionAliases?.[selector];
        if (!sessionName) {
            await this._renderPanel(chatId, {
                view: 'session',
                status: `❌ Unknown session alias: ${selector}`,
                ...options
            });
            return null;
        }
        this.selectedSessions.set(String(chatId), sessionName);
        this._persistSelectedSessions();
        // Selecting is the one action that leaves the submenu: the point of
        // picking a session is to act on it.
        await this._renderPanel(chatId, {
            view: 'root',
            status: `✅ ${this._getSessionDisplayName(sessionName)}`,
            ...options
        });
        return sessionName;
    }

    async _runPanelCommand(chatId, command, action, label = action, options = {}) {
        const sessionName = this._getPanelSession(chatId);
        const result = await this._processSessionCommand(chatId, sessionName, command, `panel ${action}`);
        await this._renderPanel(chatId, {
            status: result.ok ? `✅ ${label}` : `❌ ${result.error}`,
            ...options
        });
        return result;
    }

    async _runPanelKey(chatId, key, action) {
        const sessionName = this._getPanelSession(chatId);
        try {
            this.injector.sendKey(key, sessionName);
            this.logger.info(`Control action injected - User: ${chatId}, Session: ${sessionName}, Action: ${action}`);
            await this._renderPanel(chatId, { status: `✅ ${action}` });
            return { ok: true };
        } catch (error) {
            this.logger.error('Control key injection failed:', error.message);
            await this._renderPanel(chatId, { status: `❌ ${action}: ${error.message}` });
            return { ok: false, error: error.message };
        }
    }

    async _sendControlPanel(chatId, status = '', options = {}) {
        await this._renderPanel(chatId, { view: 'root', status, ...options });
    }

    async _sendControlSubmenu(chatId, view, options = {}) {
        if (!['root', 'model', 'effort', 'session', 'mode'].includes(view)) return;
        await this._renderPanel(chatId, { view, ...options });
    }

    /**
     * The single place the panel reaches Telegram.
     *
     * `view` and `status` are remembered per chat, so a caller that only has an
     * outcome to report ("✅ opus") re-renders whatever view the operator is
     * looking at instead of resetting them to the root.
     */
    async _renderPanel(chatId, { view, status, relocate = false } = {}) {
        const key = String(chatId);
        if (view) this.panelViews.set(key, view);
        if (status !== undefined) {
            this.panelStatus.set(key, status ? `${status} · ${this._clock()}` : '');
        }

        const current = this.panelViews.get(key) || 'root';
        const selected = this._getPanelSession(chatId);
        await this.panel.render(chatId, renderPanel({
            view: current,
            sessionLabel: this._getSessionDisplayName(selected),
            status: this.panelStatus.get(key) || '',
            sessions: current === 'session' ? this._panelSessionButtons(selected) : [],
            // Read live, and only where it is shown: the footer it comes from
            // costs a tmux capture and can change outside Telegram.
            activeMode: current === 'mode' ? this.injector.getPermissionMode(selected) : null
        }), { relocate });
    }

    _panelSessionButtons(selected) {
        return [
            {
                selector: 'default',
                label: this._getSessionDisplayName(this.config.defaultSession),
                active: this.config.defaultSession === selected
            },
            ...Object.entries(this.config.sessionAliases || {}).map(([alias, session]) => ({
                selector: alias,
                label: this._getSessionDisplayName(session),
                active: session === selected
            }))
        ];
    }

    _clock() {
        return new Date().toTimeString().slice(0, 5);
    }

    _listProjects() {
        try {
            const root = fs.realpathSync(this.config.projectsRoot);
            return fs.readdirSync(root, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(entry => entry.name)
                .sort((a, b) => a.localeCompare(b));
        } catch (error) {
            this.logger.error('Could not list projects:', error.message);
            return [];
        }
    }

    async _sendNewSessionHelp(chatId) {
        const projects = this._listProjects();
        const available = projects.length > 0
            ? `\n\nProjects:\n${projects.slice(0, 20).join('\n')}${projects.length > 20 ? '\n…' : ''}`
            : '';
        await this._sendMessage(
            chatId,
            `Create a session from an existing project:\n/new <alias> <project-folder>\n\nExample:\n/new 2 tokens-are-expensive${available}`
        );
    }

    async _createProjectSession(chatId, alias, projectReference) {
        return this._createProjectSessionConfirmed(chatId, alias, projectReference, {});
    }

    async _createProjectSessionConfirmed(chatId, alias, projectReference, confirmations) {
        try {
            if (!this.config.projectsRoot || path.isAbsolute(projectReference)) {
                throw new Error('Use a project folder relative to ~/Projects');
            }

            const projectsRoot = fs.realpathSync(this.config.projectsRoot);
            const requestedPath = path.resolve(projectsRoot, projectReference);
            const lexicallyInsideProjects = requestedPath.startsWith(`${projectsRoot}${path.sep}`);
            if (!lexicallyInsideProjects) {
                throw new Error('Project must be inside ~/Projects');
            }

            const projectExists = fs.existsSync(requestedPath);
            let projectPath = requestedPath;
            if (projectExists) {
                projectPath = fs.realpathSync(requestedPath);
                if (!projectPath.startsWith(`${projectsRoot}${path.sep}`) || !fs.statSync(projectPath).isDirectory()) {
                    throw new Error('Project must be a folder inside ~/Projects');
                }
            } else {
                // New projects are deliberately limited to a direct child of
                // Projects; this avoids creating unexpected directory trees.
                if (path.dirname(requestedPath) !== projectsRoot) {
                    throw new Error('A new project must be a direct folder under ~/Projects');
                }
            }

            const projectLabel = path.relative(projectsRoot, projectPath);
            const projectSlug = projectLabel.toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 48);
            if (!projectSlug) throw new Error('Project folder needs a usable name');
            const sessionName = `claudio-${alias}-${projectSlug}`;
            const currentAliasSession = this.config.sessionAliases?.[alias];
            const needsCreate = !projectExists;
            const needsReplace = Boolean(currentAliasSession && currentAliasSession !== sessionName);

            if ((needsCreate && !confirmations.create) || (needsReplace && !confirmations.replace)) {
                await this._requestSessionCreateConfirmation(chatId, {
                    alias,
                    projectReference,
                    projectLabel,
                    sessionName,
                    currentAliasSession,
                    needsCreate,
                    needsReplace
                });
                return false;
            }

            if (needsCreate) {
                fs.mkdirSync(requestedPath, { mode: 0o755 });
                projectPath = fs.realpathSync(requestedPath);
            }

            const existing = this.injector.getSessionInfo(sessionName);
            let created = false;
            if (existing.running) {
                const existingPath = fs.realpathSync(existing.cwd);
                if (existingPath !== projectPath) {
                    throw new Error(`Session ${sessionName} already belongs to another project`);
                }
            } else {
                this.injector.createSession(sessionName, projectPath, this.config.claudeCliPath);
                created = true;
            }

            if (created) {
                // Claude may ask for workspace trust on the first launch. The
                // explicit /new request for a folder inside the configured
                // Projects root is the user's trust decision.
                for (let attempt = 0; attempt < 16; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const pane = this.injector.capturePane(sessionName, 60);
                    if (/Quick safety check|Is this a project you created or one you trust/i.test(pane)) {
                        this.injector.selectOption(1, sessionName);
                        break;
                    }
                    if (this.injector.getPermissionMode(sessionName)) break;
                }
            }

            // A session opened from the phone is a session nobody is sitting in
            // front of, so it starts in the configured mode rather than in
            // whatever Claude last remembered for that folder.
            let modeNote = '';
            if (created && this.config.defaultMode) {
                try {
                    await this.injector.selectPermissionMode(this.config.defaultMode, sessionName);
                    modeNote = ` · ${MODE_LABELS[this.config.defaultMode]}`;
                } catch (error) {
                    this.logger.warn(`Could not set the default mode on ${sessionName}: ${error.message}`);
                    modeNote = ' · mode unchanged';
                }
            }

            this.config.sessionAliases[alias] = sessionName;
            this._persistSessionAliases();
            this.selectedSessions.set(String(chatId), sessionName);
            this._persistSelectedSessions();
            await this._renderPanel(chatId, {
                view: 'root',
                status: `✅ ${alias} · ${projectLabel}${modeNote}`,
                relocate: true
            });
            this.logger.info(`Session alias created - User: ${chatId}, Alias: ${alias}, Session: ${sessionName}, Project: ${projectLabel}`);
            return true;
        } catch (error) {
            this.logger.error('Session creation failed:', error.message);
            await this._sendMessage(chatId, `❌ ${error.message}`);
            return false;
        }
    }

    async _requestSessionCreateConfirmation(chatId, request) {
        const requestId = crypto.randomBytes(6).toString('hex');
        this.pendingSessionCreates.set(requestId, {
            ...request,
            chatId: String(chatId),
            createdAt: Date.now()
        });

        const lines = [];
        if (request.needsCreate) {
            lines.push(`📁 ${request.projectLabel} does not exist.`);
            lines.push('Create it as a new empty project?');
        }
        if (request.needsReplace) {
            lines.push(`Alias ${request.alias} currently points to ${request.currentAliasSession}.`);
            lines.push(`Reassign it to ${request.sessionName}?`);
        }
        const confirmLabel = request.needsCreate ? '✅ Create' : '✅ Replace';
        await this._sendMessage(chatId, lines.join('\n'), {
            reply_markup: {
                inline_keyboard: [[
                    { text: confirmLabel, callback_data: `new:ok:${requestId}` },
                    { text: '❌ Cancel', callback_data: `new:no:${requestId}` }
                ]]
            }
        });
    }

    async _handleNewSessionCallback(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        if (!this._canUseTokenlessCommands(chatId)) {
            await this._answerCallbackQuery(callbackQuery.id, 'Not authorized');
            return;
        }

        const [, decision, requestId] = callbackQuery.data.split(':');
        const request = this.pendingSessionCreates.get(requestId);
        if (!request || request.chatId !== String(chatId) || Date.now() - request.createdAt > 10 * 60 * 1000) {
            await this._answerCallbackQuery(callbackQuery.id, 'Request expired');
            return;
        }
        this.pendingSessionCreates.delete(requestId);

        if (decision !== 'ok') {
            await this._answerCallbackQuery(callbackQuery.id, 'Cancelled');
            await this._editMessageText(chatId, callbackQuery.message.message_id, '❌ Session creation cancelled');
            return;
        }

        await this._answerCallbackQuery(callbackQuery.id, request.needsCreate ? 'Creating…' : 'Replacing…');
        await this._editMessageText(
            chatId,
            callbackQuery.message.message_id,
            `⏳ ${request.alias} · ${request.projectLabel}`
        );
        await this._createProjectSessionConfirmed(
            chatId,
            request.alias,
            request.projectReference,
            { create: true, replace: true }
        );
    }

    _persistSessionAliases() {
        const filePath = this.config.sessionAliasesFile;
        if (!filePath) throw new Error('Session alias storage is not configured');

        const directory = path.dirname(filePath);
        const temporary = `${filePath}.${process.pid}.tmp`;
        const ordered = Object.fromEntries(
            Object.entries(this.config.sessionAliases)
                .sort(([left], [right]) => Number(left) - Number(right))
        );
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    }

    async _setPanelMode(chatId, mode, options = {}) {
        const session = this._getPanelSession(chatId);
        try {
            await this.injector.selectPermissionMode(mode, session);
            await this._renderPanel(chatId, { status: `✅ ${MODE_LABELS[mode]}`, ...options });
            return { ok: true };
        } catch (error) {
            this.logger.error('Permission mode change failed:', error.message);
            await this._renderPanel(chatId, { status: `❌ ${error.message}`, ...options });
            return { ok: false, error: error.message };
        }
    }

    async _showSessionStatus(chatId) {
        const info = this.injector.getSessionInfo(this._getPanelSession(chatId));
        await this._renderPanel(chatId, {
            status: info.running ? `🟢 ${info.cwd}` : `🔴 ${info.session} is not running`
        });
    }

    _startPermissionMonitor() {
        if (this.permissionPollInterval || !this.config.chatId) return;

        const poll = () => this._pollPermissionPrompts().catch(error => {
            this.logger.error('Permission monitor failed:', error.message);
        });
        poll();
        this.permissionPollInterval = setInterval(poll, 2000);
        this.logger.info('Telegram permission monitor started');
    }

    _startActivityMonitor() {
        if (this.activityPollInterval) return;

        const poll = () => this._pollActiveTelegramTasks().catch(error => {
            this.logger.error('Activity monitor failed:', error.message);
        });
        this.activityPollInterval = setInterval(poll, 4000);
        this.logger.info('Telegram activity indicator started');
    }

    async _markTelegramTaskActive(chatId, session) {
        this.activeTelegramTasks.set(session, {
            chatId,
            startedAt: Date.now()
        });
        await this._sendChatAction(chatId, 'typing');
    }

    async _pollActiveTelegramTasks() {
        for (const [session, task] of this.activeTelegramTasks.entries()) {
            const pane = this.injector.capturePane(session, 40);
            const bottom = pane.split('\n').slice(-14).join('\n');

            // A permission message replaces the typing indicator until the
            // user makes a choice. Keep tracking so typing resumes afterward.
            if (/Do you want to proceed\?/i.test(bottom)) continue;

            const isBusy = /esc to interrupt/i.test(bottom);
            const isStarting = Date.now() - task.startedAt < 15000;
            if (isBusy || isStarting) {
                await this._sendChatAction(task.chatId, 'typing');
            } else {
                this.activeTelegramTasks.delete(session);
            }
        }
    }

    async _pollPermissionPrompts() {
        const sessions = new Set([
            this.config.defaultSession,
            ...Object.values(this.config.sessionAliases || {})
        ].filter(Boolean));

        for (const session of sessions) {
            const pane = this.injector.capturePane(session, 100);
            const prompt = this._parsePermissionPrompt(pane, session);
            if (!prompt) {
                this.permissionState.delete(session);
                continue;
            }
            if (this.permissionState.get(session) === prompt.id) continue;

            this.permissionState.set(session, prompt.id);
            this.permissionPrompts.set(prompt.id, prompt);
            const buttons = prompt.options.map(option => ({
                text: this._permissionButtonLabel(option),
                callback_data: `perm:${option.number}:${prompt.id}`
            }));
            await this._sendMessage(
                this.config.chatId,
                `🔐 Permission requested · ${session}\n\n${prompt.summary}`,
                { reply_markup: { inline_keyboard: [buttons] } }
            );
        }
    }

    _parsePermissionPrompt(pane, session) {
        if (!pane || !/Do you want to proceed\?/i.test(pane)) return null;

        const clean = pane.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
        const questionIndex = clean.lastIndexOf('Do you want to proceed?');
        const relevant = clean.slice(Math.max(0, questionIndex - 1800), questionIndex + 900);
        const options = [];
        for (const match of relevant.matchAll(/^\s*[❯>]?\s*([1-3])\.\s+(.+)$/gm)) {
            const number = Number(match[1]);
            if (!options.some(option => option.number === number)) {
                options.push({ number, label: match[2].trim() });
            }
        }
        if (options.length < 2) return null;

        const summaryLines = relevant.slice(0, relevant.indexOf('Do you want to proceed?'))
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !/^[-─━]+$/.test(line));
        const summary = summaryLines.slice(-16).join('\n').slice(-1400);
        const fingerprint = crypto.createHash('sha256')
            .update(`${session}\n${summary}\n${options.map(option => option.label).join('\n')}`)
            .digest('hex')
            .slice(0, 12);

        return { id: fingerprint, session, summary, options };
    }

    _permissionButtonLabel(option) {
        if (/don['’]t ask again/i.test(option.label)) return '✅ Always';
        if (/^yes/i.test(option.label)) return '✅ Once';
        if (/^no/i.test(option.label)) return '❌ Deny';
        return `${option.number}. ${option.label}`.slice(0, 30);
    }

    async _handlePermissionCallback(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        if (!this._canUseTokenlessCommands(chatId)) {
            await this._answerCallbackQuery(callbackQuery.id, 'Not authorized');
            return;
        }

        const [, optionText, promptId] = callbackQuery.data.split(':');
        const prompt = this.permissionPrompts.get(promptId);
        const option = prompt?.options.find(item => item.number === Number(optionText));
        if (!prompt || !option) {
            await this._answerCallbackQuery(callbackQuery.id, 'This prompt has expired');
            return;
        }

        try {
            this.injector.selectOption(option.number, prompt.session);
            await this._answerCallbackQuery(callbackQuery.id, option.label);
            await this._editMessageText(
                chatId,
                callbackQuery.message.message_id,
                `${this._permissionButtonLabel(option)} · ${prompt.session}\n\n${prompt.summary}`
            );
            this.permissionPrompts.delete(promptId);
        } catch (error) {
            await this._answerCallbackQuery(callbackQuery.id, error.message);
        }
    }

    async _sendWelcomeMessage(chatId) {
        const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `In your personal chat, send a command as plain text or use:\n` +
            `\`1 <your command>\` for session alias 1.\n\n` +
            `Token-based commands remain available as:\n` +
            `\`/cmd <TOKEN> <your command>\`\n\n` +
            `Type /help for more information.`;
        
        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async _sendHelpMessage(chatId) {
        const aliasLines = Object.entries(this.config.sessionAliases || {})
            .map(([alias, session]) => `• \`${alias} <command>\` → ${session}`)
            .join('\n');
        const message = `📚 *Claude Code Remote Bot Help*\n\n` +
            `*Commands:*\n` +
            `• \`/start\` - Welcome message\n` +
            `• \`/help\` - Show this help\n` +
            `• \`/panel\` - Open session, model and action buttons\n` +
            `• \`/model <sonnet|opus|haiku>\` - Select a model\n` +
            `• \`/effort <auto|low|medium|high|xhigh|max>\` - Set reasoning effort\n` +
            `• \`/mode <ask|edits|plan|auto>\` - Set permission mode\n` +
            `• \`/session <alias>\` - Select the panel session\n` +
            `• \`/new <alias> <project>\` - Open an existing project in a new session\n` +
            `• \`<command>\` - Send to ${this._getPanelSession(chatId)}\n` +
            `• \`/cmd <command>\` - Send to ${this._getPanelSession(chatId)}\n` +
            `${aliasLines ? `${aliasLines}\n` : ''}` +
            `• \`/cmd <TOKEN> <command>\` - Explicit notification session\n\n` +
            `*Examples:*\n` +
            `\`review the latest changes\`\n` +
            `\`1 run the tests\`\n` +
            `\`/new 2 tokens-are-expensive\`\n\n` +
            `*Tips:*\n` +
            `• Shortcuts work only in the configured personal chat\n` +
            `• Groups still require tokens\n` +
            `• Notification tokens expire after 24 hours`;
        
        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    _isAuthorized(userId, chatId) {
        // Check whitelist
        const whitelist = this.config.whitelist || [];
        
        if (whitelist.includes(String(chatId)) || whitelist.includes(String(userId))) {
            return true;
        }
        
        // If no whitelist configured, allow configured chat/user
        if (whitelist.length === 0) {
            const configuredChatId = this.config.chatId || this.config.groupId;
            if (configuredChatId && String(chatId) === String(configuredChatId)) {
                return true;
            }
        }
        
        return false;
    }

    async _getBotUsername() {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions()
            );
            
            if (response.data.ok && response.data.result.username) {
                this.botUsername = response.data.result.username;
                return this.botUsername;
            }
        } catch (error) {
            this.logger.error('Failed to get bot username:', error.message);
        }
        
        // Fallback to configured username or default
        return this.config.botUsername || 'claude_remote_bot';
    }

    async _findSessionByToken(token) {
        const files = fs.readdirSync(this.sessionsDir);
        
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error) {
                this.logger.error(`Failed to read session file ${file}:`, error.message);
            }
        }
        
        return null;
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    async _sendMessage(chatId, text, options = {}) {
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: text,
                    ...options
                },
                this._getNetworkOptions()
            );
            return response.data?.result?.message_id ?? null;
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
            return null;
        }
    }

    async _sendChatAction(chatId, action) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendChatAction`,
                { chat_id: chatId, action },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.debug('Failed to send Telegram chat action:', error.message);
        }
    }

    /**
     * @returns {Promise<{ok: boolean, gone?: boolean}>} `gone` means the message
     * cannot be edited any more, so the caller should send a new one instead of
     * retrying into a message that no longer exists.
     */
    async _editMessageText(chatId, messageId, text, options = { reply_markup: { inline_keyboard: [] } }) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/editMessageText`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    text,
                    ...options
                },
                this._getNetworkOptions()
            );
            return { ok: true };
        } catch (error) {
            const description = error.response?.data?.description || error.message || '';
            // Re-rendering an unchanged panel is normal: the operator can press
            // the button for the view they are already looking at.
            if (/message is not modified/i.test(description)) return { ok: true };
            const gone = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|message identifier is not specified/i
                .test(description);
            this.logger.warn(`Failed to edit Telegram message: ${description}`);
            return { ok: false, gone };
        }
    }

    async _deleteMessage(chatId, messageId) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/deleteMessage`,
                { chat_id: chatId, message_id: messageId },
                this._getNetworkOptions()
            );
        } catch (error) {
            // Already gone, or older than Telegram's delete window: either way
            // the anchor is being replaced, so there is nothing to recover.
            this.logger.debug('Could not delete Telegram message:', error.response?.data?.description || error.message);
        }
    }

    async _answerCallbackQuery(callbackQueryId, text = '') {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/answerCallbackQuery`,
                {
                    callback_query_id: callbackQueryId,
                    text: text
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to answer callback query:', error.response?.data || error.message);
        }
    }

    async setWebhook(webhookUrl) {
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setWebhook`,
                {
                    url: webhookUrl,
                    allowed_updates: ['message', 'callback_query'],
                    secret_token: this.config.webhookSecret
                },
                this._getNetworkOptions()
            );

            this.logger.info('Webhook set successfully:', response.data);
            return response.data;
        } catch (error) {
            this.logger.error('Failed to set webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    async setBotCommands() {
        const commands = [
            { command: 'panel', description: 'Open Claude controls' },
            { command: 'model', description: 'Choose Sonnet, Opus or Haiku' },
            { command: 'effort', description: 'Set Claude reasoning effort' },
            { command: 'mode', description: 'Set Claude permission mode' },
            { command: 'session', description: 'Choose a session alias' },
            { command: 'new', description: 'Open an existing project session' },
            { command: 'cmd', description: 'Send a command to Claude' },
            { command: 'help', description: 'Show usage help' },
            { command: 'start', description: 'Start the bot' }
        ];

        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setMyCommands`,
                { commands },
                this._getNetworkOptions()
            );
            this.logger.info('Telegram command menu set successfully');
            return response.data;
        } catch (error) {
            this.logger.error('Failed to set Telegram command menu:', error.response?.data || error.message);
            throw error;
        }
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            this.logger.info(`Telegram webhook server started on port ${port}`);
        });
        this._startPermissionMonitor();
        this._startActivityMonitor();
    }
}

module.exports = TelegramWebhookHandler;
