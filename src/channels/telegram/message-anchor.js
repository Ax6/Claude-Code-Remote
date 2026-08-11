/**
 * One message per chat, edited in place.
 *
 * The anchor owns a message_id and nothing else: callers hand it a rendered
 * view and it decides whether that view becomes an edit of the message that is
 * already there or a new message. Two rules make it predictable in a chat:
 *
 *   - a button press edits in place, so the panel stays where it is;
 *   - a typed command relocates, because the user is looking at the bottom of
 *     the chat and an edit twenty messages up is an edit nobody sees.
 *
 * The id is persisted so a webhook restart keeps talking to the same bubble
 * instead of stacking a fresh one on every deploy.
 */

const fs = require('fs');
const path = require('path');

// Telegram refuses to edit messages older than 48h; relocate before that edge
// rather than discovering it as an API error.
const EDIT_WINDOW_MS = 47 * 60 * 60 * 1000;

class MessageAnchor {
    /**
     * @param {Object} options
     * @param {string} [options.filePath]  Where the ids are persisted.
     * @param {Object} options.logger
     * @param {(chatId: string|number, text: string, options: Object) => Promise<number|null>} options.send
     * @param {(chatId: string|number, messageId: number, text: string, options: Object) => Promise<{ok: boolean, gone?: boolean}>} options.edit
     * @param {(chatId: string|number, messageId: number) => Promise<void>} options.remove
     */
    constructor({ filePath, logger, send, edit, remove }) {
        this.filePath = filePath;
        this.logger = logger;
        this.send = send;
        this.edit = edit;
        this.remove = remove;
        this.anchors = this._load();
        this.queues = new Map();
    }

    /**
     * @param {string|number} chatId
     * @param {{text: string, reply_markup: Object}} view
     * @param {{relocate?: boolean}} [options]
     */
    async render(chatId, view, options = {}) {
        // Serialized per chat: two buttons pressed in quick succession would
        // otherwise race to create two anchors, which is the pile-up this class
        // exists to prevent.
        const key = String(chatId);
        const previous = this.queues.get(key) || Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(() => this._render(key, chatId, view, options));
        this.queues.set(key, next);
        try {
            return await next;
        } finally {
            if (this.queues.get(key) === next) this.queues.delete(key);
        }
    }

    async _render(key, chatId, view, { relocate = false }) {
        const anchor = this.anchors.get(key);
        const markup = { reply_markup: view.reply_markup };
        const editable = anchor && Date.now() - anchor.updatedAt < EDIT_WINDOW_MS;

        if (anchor && relocate) {
            // Relocating leaves nothing behind: the old panel would still carry
            // live buttons pointing at state it no longer displays.
            await this.remove(chatId, anchor.messageId);
            this.anchors.delete(key);
        } else if (editable) {
            const result = await this.edit(chatId, anchor.messageId, view.text, markup);
            if (result.ok) {
                this._touch(key, anchor.messageId);
                return anchor.messageId;
            }
            if (!result.gone) return anchor.messageId; // transient failure, keep the anchor
            this.anchors.delete(key);
        }

        const messageId = await this.send(chatId, view.text, markup);
        if (messageId) this._touch(key, messageId);
        return messageId;
    }

    /**
     * Treat a message the operator just interacted with as the anchor.
     *
     * A button press is unambiguous about which bubble the operator means, and
     * that beats the stored id whenever the two disagree -- after the state file
     * is cleared, or when an older panel is still on screen.
     */
    adopt(chatId, messageId) {
        if (!Number.isInteger(messageId)) return;
        const key = String(chatId);
        if (this.anchors.get(key)?.messageId === messageId) return;
        this._touch(key, messageId);
    }

    /** The panel moved out from under us (deleted by the user, for instance). */
    forget(chatId) {
        if (this.anchors.delete(String(chatId))) this._persist();
    }

    _touch(key, messageId) {
        this.anchors.set(key, { messageId, updatedAt: Date.now() });
        this._persist();
    }

    _load() {
        try {
            if (!this.filePath || !fs.existsSync(this.filePath)) return new Map();
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return new Map(
                Object.entries(parsed)
                    .filter(([chatId, anchor]) =>
                        /^-?\d+$/.test(chatId) &&
                        anchor && Number.isInteger(anchor.messageId) && Number.isFinite(anchor.updatedAt))
                    .map(([chatId, anchor]) => [chatId, { messageId: anchor.messageId, updatedAt: anchor.updatedAt }])
            );
        } catch (error) {
            this.logger?.warn(`Could not load panel anchors: ${error.message}`);
            return new Map();
        }
    }

    _persist() {
        if (!this.filePath) return;
        try {
            const temporary = `${this.filePath}.${process.pid}.tmp`;
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(
                temporary,
                `${JSON.stringify(Object.fromEntries(this.anchors), null, 2)}\n`,
                { mode: 0o600 }
            );
            fs.renameSync(temporary, this.filePath);
        } catch (error) {
            this.logger?.warn(`Could not persist panel anchors: ${error.message}`);
        }
    }
}

module.exports = MessageAnchor;
