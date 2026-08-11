/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API with command support
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');
const { toRichMarkdown, splitRichMarkdown } = require('./rich-markdown');
const { SuggestionStore, looksLikeSuggestion, suggestionKeyboard } = require('./suggestion-store');

class TelegramChannel extends NotificationChannel {
    constructor(config = {}) {
        super('telegram', config);
        this.sessionsDir = process.env.SESSION_DATA_DIR || path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        this.suggestions = new SuggestionStore({
            filePath: process.env.TELEGRAM_SUGGESTIONS_FILE ||
                path.join(path.dirname(this.sessionsDir), 'reply-suggestions.json'),
            logger: this.logger
        });

        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig() {
        if (!this.config.botToken) {
            this.logger.warn('Telegram Bot Token not found');
            return false;
        }
        if (!this.config.chatId && !this.config.groupId) {
            this.logger.warn('Telegram Chat ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    /**
     * Generate network options for axios requests
     * @returns {Object} Network options object
     */
    _getNetworkOptions() {
        const options = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    _generateToken() {
        // Generate short Token (uppercase letters + numbers, 8 digits)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }

    _getCurrentTmuxSession() {
        try {
            // Try to get current tmux session
            const tmuxSession = execSync('tmux display-message -p "#S"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            
            return tmuxSession || null;
        } catch (error) {
            // Not in a tmux session or tmux not available
            return null;
        }
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

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('Telegram channel not properly configured');
        }

        // Generate session ID and Token
        const sessionId = uuidv4();
        const token = this._generateToken();
        
        // Get current tmux session and conversation content
        const tmuxSession = this._getCurrentTmuxSession();
        if (tmuxSession && !notification.metadata) {
            const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
            notification.metadata = {
                userQuestion: conversation.userQuestion || notification.message,
                claudeResponse: conversation.claudeResponse || notification.message,
                tmuxSession: tmuxSession
            };
        }
        
        // Create session record
        await this._createSession(sessionId, notification, token);

        // Generate Telegram message
        const isDirectReply = Boolean(notification.metadata?.directReply);
        const messageText = isDirectReply
            ? this._generateDirectReply(notification)
            : this._generateTelegramMessage(notification, sessionId, token);
        
        // Determine recipient (chat or group)
        const chatId = this.config.groupId || this.config.chatId;
        const isGroupChat = !!this.config.groupId;
        
        const buttons = this._notificationButtons({ isDirectReply, isGroupChat, token });
        
        const sent = await this._sendRich(chatId, messageText, buttons);
        if (sent) {
            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}`);
            // An answer is what a suggested reply gets attached to, so where it
            // landed has to outlive this process.
            if (isDirectReply && sent.messageId) {
                this.suggestions.rememberReply(chatId, {
                    messageId: sent.messageId,
                    session: notification.metadata?.tmuxSession || null
                });
            }
            return true;
        }

        // Clean up failed session
        await this._removeSession(sessionId);
        return false;
    }

    /**
     * The buttons under a notification.
     *
     * The two it used to carry -- "Personal Chat" and "Group Chat" -- were named
     * after an auto-fill that no longer exists. Upstream used
     * `switch_inline_query_current_chat`, which prefills the input field but also
     * inserts the bot's username, wrong in a private chat; this fork replaced it
     * with a callback that replies with a format to copy by hand. So the tip
     * promising "a button that auto-fills the command" pointed at a button that
     * sent a wall of text.
     *
     * `copy_text` is the affordance that was missing: a real button that puts
     * `/cmd <TOKEN> ` on the clipboard, no username, nothing sent. And in the
     * personal chat it is not needed at all -- plain text already reaches the
     * selected session, so the token ritual is only for chats that require one.
     */
    _notificationButtons({ isDirectReply, isGroupChat, token }) {
        const controls = [{ text: '🎛 Controls', callback_data: 'ctl:panel' }];
        if (isDirectReply) return [controls];

        const tokenless = this.config.allowTokenlessCommands === true && !isGroupChat;
        if (tokenless) return [controls];

        return [
            [{ text: '📋 Copy /cmd', copy_text: { text: `/cmd ${token} ` } }],
            controls
        ];
    }

    /**
     * Send Markdown as Telegram renders it, with plain text as the floor.
     *
     * `sendRichMessage` is what turns Claude's output into headings, lists,
     * tables and highlighted code instead of a wall of asterisks, and it carries
     * 32768 characters where a text message carries 4096. It is also newer than
     * the rest of this channel, so a rejection falls back to plain text: a reply
     * that arrives unstyled beats a reply that does not arrive.
     */
    async _sendRich(chatId, markdown, buttons) {
        const chunks = splitRichMarkdown(toRichMarkdown(markdown));
        if (chunks.length === 0) return { messageId: null };

        let lastMessageId = null;
        for (const [index, chunk] of chunks.entries()) {
            const isLast = index === chunks.length - 1;
            const payload = {
                chat_id: chatId,
                rich_message: { markdown: chunk }
            };
            // Buttons belong on the last piece, where the reply ends.
            if (isLast) payload.reply_markup = { inline_keyboard: buttons };

            try {
                const response = await axios.post(
                    `${this.apiBaseUrl}/bot${this.config.botToken}/sendRichMessage`,
                    payload,
                    this._getNetworkOptions()
                );
                if (isLast) lastMessageId = response.data?.result?.message_id ?? null;
            } catch (error) {
                this.logger.warn(
                    `Rich message rejected, falling back to plain text: ${JSON.stringify(error.response?.data?.description || error.message)}`
                );
                return this._sendPlain(chatId, markdown, buttons);
            }
        }

        return { messageId: lastMessageId };
    }

    /**
     * The fallback carries no parse_mode on purpose. Claude's prose is full of
     * underscores and asterisks that Telegram's parsers reject outright, and a
     * rejected message is a message the operator never sees.
     */
    async _sendPlain(chatId, text, buttons) {
        const body = String(text);
        const clipped = body.length > 4000 ? `${body.slice(0, 3997)}...` : body;
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: clipped,
                    reply_markup: { inline_keyboard: buttons }
                },
                this._getNetworkOptions()
            );
            return { messageId: null };
        } catch (error) {
            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            return false;
        }
    }

    /**
     * Turn a suggested reply into a button on the answer it follows.
     *
     * The suggestion arrives seconds after the answer, from a different hook and
     * a different process, and it is one line the operator might say next -- so
     * it belongs on that answer as something to press, not in a bubble of its own
     * that reads like a message nobody wrote.
     */
    async offerSuggestion({ text, session }) {
        if (!looksLikeSuggestion(text)) return false;

        const chatId = this.config.groupId || this.config.chatId;
        const entry = this.suggestions.read(chatId);
        if (!entry || (session && entry.session && entry.session !== session)) return false;

        const added = this.suggestions.addSuggestion(chatId, String(text).trim());
        if (!added) return false;

        const rows = suggestionKeyboard(
            { suggestions: added.suggestions },
            [[{ text: '🎛 Controls', callback_data: 'ctl:panel' }]]
        );
        return this._editReplyMarkup(chatId, added.messageId, rows);
    }

    async _editReplyMarkup(chatId, messageId, rows) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/editMessageReplyMarkup`,
                { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } },
                this._getNetworkOptions()
            );
            return true;
        } catch (error) {
            this.logger.warn(`Could not attach suggestion: ${error.response?.data?.description || error.message}`);
            return false;
        }
    }

    _generateDirectReply(notification) {
        const response = String(notification.metadata?.claudeResponse || '').trim();
        if (!response) return 'Claude finished without a text response.';

        // No truncation here any more: the rich limit is 32768 characters and
        // anything longer is split between blocks rather than cut mid-sentence.
        return response;
    }

    _clip(text, limit) {
        const value = String(text);
        return value.length > limit ? `${value.substring(0, limit)}...` : value;
    }

    /**
     * Written in rich Markdown, where `**` is bold -- legacy `*single*` means
     * italic here. Nothing is escaped by hand: `toRichMarkdown` escapes the
     * prose on the way out, so a project name or a quoted question cannot break
     * the message, and the escaping happens once rather than per call site.
     */
    _generateTelegramMessage(notification, sessionId, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        let messageText = `${emoji} **Claude Task ${status}**\n`;
        messageText += `**Project:** ${notification.project}\n`;
        messageText += `**Session Token:** \`${token}\`\n\n`;

        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                messageText += `📝 **Your Question:**\n${this._clip(notification.metadata.userQuestion, 200)}`;
                messageText += '\n\n';
            }

            if (notification.metadata.claudeResponse) {
                messageText += `🤖 **Claude Response:**\n${this._clip(notification.metadata.claudeResponse, 300)}`;
                messageText += '\n\n';
            }
        }

        messageText += `💬 **To send a new command:**\n`;
        messageText += `Reply with: \`/cmd ${token} <your command>\`\n`;
        messageText += `Example: \`/cmd ${token} Please analyze this code\``;

        return messageText;
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'telegram',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Expires after 24 hours
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            tmuxSession: notification.metadata?.tmuxSession || 'default',
            project: notification.project,
            notification: notification
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        this.logger.debug(`Session created: ${sessionId}`);
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = TelegramChannel;
