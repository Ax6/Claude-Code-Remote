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
        
        if (!messageText) return;

        // Check if user is authorized
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

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
            await this._sendControlPanel(chatId);
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
            await this._sendControlSubmenu(chatId, submenuCommands[messageText]);
            return;
        }

        const directModel = messageText.match(/^\/model\s+(sonnet|opus|haiku)$/i);
        if (directModel) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._runPanelCommand(chatId, `/model ${directModel[1].toLowerCase()}`, 'model');
            return;
        }

        const directEffort = messageText.match(/^\/effort\s+(auto|low|medium|high|xhigh|max)$/i);
        if (directEffort) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._runPanelCommand(chatId, `/effort ${directEffort[1].toLowerCase()}`, 'effort');
            return;
        }

        const directSession = messageText.match(/^\/session\s+(default|\d+)$/i);
        if (directSession) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._selectPanelSession(chatId, directSession[1].toLowerCase());
            return;
        }

        const directMode = messageText.match(/^\/mode\s+(ask|edits|plan|auto)$/i);
        if (directMode) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const modes = { ask: 'default', edits: 'acceptEdits', plan: 'plan', auto: 'auto' };
            await this._setPanelMode(chatId, modes[directMode[1].toLowerCase()]);
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

        // Personal-chat default session: "/cmd review" or simply "review".
        const defaultCommand = messageText.match(/^\/cmd\s+(.+)$/s)?.[1] ||
            (!messageText.startsWith('/') ? messageText : null);
        if (defaultCommand) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._processSessionCommand(
                chatId,
                this.config.defaultSession,
                defaultCommand,
                'default'
            );
            return;
        }

        await this._sendHelpMessage(chatId);
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
        try {
            await this.injector.injectCommand(command, sessionName);
            if (!routeLabel.startsWith('panel ')) {
                await this._markTelegramTaskActive(chatId, sessionName);
            }
            this.logger.info(`Command injected - User: ${chatId}, Session: ${sessionName}, Route: ${routeLabel}, Command: ${command}`);
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId, `❌ Command execution failed: ${error.message}`);
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

        if (data.startsWith('ctl:o:')) {
            await this._handleModeCallback(callbackQuery);
            return;
        }

        if (data.startsWith('new:')) {
            await this._handleNewSessionCallback(callbackQuery);
            return;
        }
        
        // Answer callback query to remove loading state
        await this._answerCallbackQuery(callbackQuery.id);

        if (data === 'ctl:panel') {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._sendControlPanel(chatId);
            return;
        }

        if (data.startsWith('ctl:v:')) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._sendControlSubmenu(chatId, data.slice('ctl:v:'.length));
            return;
        }

        if (data === 'ctl:new') {
            await this._sendNewSessionHelp(chatId);
            return;
        }

        if (data.startsWith('ctl:s:')) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            await this._selectPanelSession(chatId, data.slice('ctl:s:'.length));
            return;
        }

        if (data.startsWith('ctl:m:')) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const model = data.slice('ctl:m:'.length);
            if (!['sonnet', 'opus', 'haiku'].includes(model)) return;
            await this._runPanelCommand(chatId, `/model ${model}`, 'model');
            return;
        }

        if (data.startsWith('ctl:e:')) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const effort = data.slice('ctl:e:'.length);
            if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return;
            await this._runPanelCommand(chatId, `/effort ${effort}`, 'effort');
            return;
        }

        if (data.startsWith('ctl:a:')) {
            if (!this._canUseTokenlessCommands(chatId)) {
                await this._sendTokenRequiredMessage(chatId);
                return;
            }
            const action = data.slice('ctl:a:'.length);
            const commands = {
                continue: 'continue',
                compact: '/compact'
            };
            if (action === 'stop') {
                await this._runPanelKey(chatId, 'C-c', 'stop');
            } else if (action === 'status') {
                await this._sendSessionStatus(chatId);
            } else if (commands[action]) {
                await this._runPanelCommand(chatId, commands[action], action);
            }
            return;
        }
        
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

    async _selectPanelSession(chatId, selector) {
        const sessionName = selector === 'default'
            ? this.config.defaultSession
            : this.config.sessionAliases?.[selector];
        if (!sessionName) {
            await this._sendMessage(chatId, `❌ Unknown session alias: ${selector}`);
            return;
        }
        this.selectedSessions.set(String(chatId), sessionName);
        this._persistSelectedSessions();
        await this._sendControlPanel(chatId, `✅ Selected session: ${sessionName}`);
    }

    async _runPanelCommand(chatId, command, action) {
        const sessionName = this._getPanelSession(chatId);
        await this._processSessionCommand(chatId, sessionName, command, `panel ${action}`);
    }

    async _runPanelKey(chatId, key, action) {
        const sessionName = this._getPanelSession(chatId);
        try {
            this.injector.sendKey(key, sessionName);
            this.logger.info(`Control action injected - User: ${chatId}, Session: ${sessionName}, Action: ${action}`);
        } catch (error) {
            this.logger.error('Control key injection failed:', error.message);
            await this._sendMessage(chatId, `❌ ${action} failed: ${error.message}`);
        }
    }

    async _sendControlPanel(chatId, prefix = '') {
        const selected = this._getPanelSession(chatId);
        const selectedLabel = this._getSessionDisplayName(selected);
        const rows = [
            [
                { text: '🖥 Session', callback_data: 'ctl:v:session' },
                { text: '🤖 Model', callback_data: 'ctl:v:model' },
                { text: '🧠 Effort', callback_data: 'ctl:v:effort' },
                { text: '🛡 Mode', callback_data: 'ctl:v:mode' }
            ],
            [
                { text: '▶️ Continue', callback_data: 'ctl:a:continue' },
                { text: '🧹 Compact', callback_data: 'ctl:a:compact' },
                { text: '⏹ Stop', callback_data: 'ctl:a:stop' }
            ]
        ];

        const heading = prefix ? `${prefix}\n\n` : '';
        await this._sendMessage(
            chatId,
            `${heading}🎛 ${selectedLabel}`,
            { reply_markup: { inline_keyboard: rows } }
        );
    }

    async _sendControlSubmenu(chatId, view) {
        const selected = this._getPanelSession(chatId);
        const selectedLabel = this._getSessionDisplayName(selected);
        let title;
        let rows;

        if (view === 'model') {
            title = `🤖 Model · ${selectedLabel}`;
            rows = [[
                { text: 'Sonnet', callback_data: 'ctl:m:sonnet' },
                { text: 'Opus', callback_data: 'ctl:m:opus' },
                { text: 'Haiku', callback_data: 'ctl:m:haiku' }
            ]];
        } else if (view === 'effort') {
            title = `🧠 Effort · ${selectedLabel}`;
            rows = [
                [
                    { text: 'Auto', callback_data: 'ctl:e:auto' },
                    { text: 'Low', callback_data: 'ctl:e:low' },
                    { text: 'Medium', callback_data: 'ctl:e:medium' }
                ],
                [
                    { text: 'High', callback_data: 'ctl:e:high' },
                    { text: 'XHigh', callback_data: 'ctl:e:xhigh' },
                    { text: 'Max', callback_data: 'ctl:e:max' }
                ]
            ];
        } else if (view === 'session') {
            title = `🖥 Session · ${selectedLabel}`;
            const buttons = [
                { text: 'Default', callback_data: 'ctl:s:default' },
                ...Object.entries(this.config.sessionAliases || {}).map(([alias, session]) => {
                    const info = this.injector.getSessionInfo(session);
                    let folder = info.cwd ? path.basename(info.cwd) : '';
                    const prefix = `claudio-${alias}-`;
                    if (!folder && session.startsWith(prefix)) folder = session.slice(prefix.length);
                    if (!folder) folder = session;
                    return {
                        text: `${alias} · ${folder}`,
                        callback_data: `ctl:s:${alias}`
                    };
                }),
                { text: '➕ New', callback_data: 'ctl:new' }
            ];
            rows = [];
            for (let i = 0; i < buttons.length; i += 3) {
                rows.push(buttons.slice(i, i + 3));
            }
        } else if (view === 'mode') {
            title = `🛡 Mode · ${selectedLabel}`;
            const activeMode = this.injector.getPermissionMode(selected);
            const modes = [
                ['Ask', 'default'],
                ['Edits', 'acceptEdits'],
                ['Plan', 'plan'],
                ['Auto', 'auto']
            ];
            rows = [modes.map(([label, mode]) => ({
                text: `${activeMode === mode ? '✓ ' : ''}${label}`,
                callback_data: `ctl:o:${mode}`
            }))];
        } else {
            return;
        }

        await this._sendMessage(chatId, title, { reply_markup: { inline_keyboard: rows } });
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

            this.config.sessionAliases[alias] = sessionName;
            this._persistSessionAliases();
            this.selectedSessions.set(String(chatId), sessionName);
            this._persistSelectedSessions();
            await this._sendMessage(
                chatId,
                `✅ ${alias} · ${projectLabel}`,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🎛 Controls', callback_data: 'ctl:panel' }
                        ]]
                    }
                }
            );
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

    async _setPanelMode(chatId, mode) {
        const session = this._getPanelSession(chatId);
        try {
            await this.injector.selectPermissionMode(mode, session);
            return mode;
        } catch (error) {
            this.logger.error('Permission mode change failed:', error.message);
            await this._sendMessage(chatId, `❌ ${error.message}`);
            return null;
        }
    }

    async _handleModeCallback(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        if (!this._canUseTokenlessCommands(chatId)) {
            await this._answerCallbackQuery(callbackQuery.id, 'Not authorized');
            return;
        }

        const mode = callbackQuery.data.slice('ctl:o:'.length);
        if (!['default', 'acceptEdits', 'plan', 'auto'].includes(mode)) {
            await this._answerCallbackQuery(callbackQuery.id, 'Invalid mode');
            return;
        }

        const changed = await this._setPanelMode(chatId, mode);
        const labels = { default: 'Ask', acceptEdits: 'Edits', plan: 'Plan', auto: 'Auto' };
        await this._answerCallbackQuery(
            callbackQuery.id,
            changed ? `Mode: ${labels[changed]}` : 'Mode change failed'
        );
    }

    async _sendSessionStatus(chatId) {
        const info = this.injector.getSessionInfo(this._getPanelSession(chatId));
        const text = info.running
            ? `🟢 ${info.session}\n${info.cwd}\n${info.command}`
            : `🔴 ${info.session} is not running`;
        await this._sendMessage(chatId, text);
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
            `• \`<command>\` - Send to ${this.config.defaultSession}\n` +
            `• \`/cmd <command>\` - Send to ${this.config.defaultSession}\n` +
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
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: text,
                    ...options
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
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

    async _editMessageText(chatId, messageId, text) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/editMessageText`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    text,
                    reply_markup: { inline_keyboard: [] }
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to edit Telegram message:', error.response?.data || error.message);
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
