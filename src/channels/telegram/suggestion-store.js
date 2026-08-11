/**
 * Suggested replies, shared between two processes.
 *
 * The harness produces a short follow-up suggestion a few seconds after an
 * answer, and it arrives at the SubagentStop hook -- in a different process from
 * the webhook that would have to act on a press. So the suggestion cannot live
 * in memory: the notifier writes it here and adds a button, the webhook reads it
 * back when the button is pressed.
 *
 * `callback_data` is capped at 64 bytes, which is why the button carries an id
 * rather than the text. Every method re-reads the file, because the two
 * processes would otherwise act on each other's stale copy.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// A suggestion is only interesting while the answer it belongs to is still the
// last thing said.
const REPLY_WINDOW_MS = 30 * 60 * 1000;
const MAX_SUGGESTIONS = 3;

class SuggestionStore {
    constructor({ filePath, logger } = {}) {
        this.filePath = filePath;
        this.logger = logger;
    }

    /** Note the message an answer landed in, and drop any older suggestions. */
    rememberReply(chatId, { messageId, session }) {
        if (!this.filePath || !Number.isInteger(messageId)) return;
        const state = this._read();
        state[String(chatId)] = { messageId, session, updatedAt: Date.now(), suggestions: [] };
        this._write(state);
    }

    /**
     * @returns {{id: string, suggestions: Array}|null} null when there is no
     * recent answer to attach a button to.
     */
    addSuggestion(chatId, text) {
        if (!this.filePath) return null;
        const state = this._read();
        const entry = state[String(chatId)];
        if (!entry || Date.now() - entry.updatedAt > REPLY_WINDOW_MS) return null;
        if (entry.suggestions.some(suggestion => suggestion.text === text)) return null;
        if (entry.suggestions.length >= MAX_SUGGESTIONS) return null;

        const id = crypto.randomBytes(6).toString('hex');
        entry.suggestions.push({ id, text });
        this._write(state);
        return { id, messageId: entry.messageId, suggestions: entry.suggestions };
    }

    read(chatId) {
        return this._read()[String(chatId)] || null;
    }

    /** Consume a suggestion; a button cannot fire the same reply twice. */
    take(id) {
        const state = this._read();
        for (const [chatId, entry] of Object.entries(state)) {
            const index = entry.suggestions?.findIndex(suggestion => suggestion.id === id);
            if (index === undefined || index < 0) continue;
            const [suggestion] = entry.suggestions.splice(index, 1);
            this._write(state);
            return {
                chatId,
                messageId: entry.messageId,
                session: entry.session,
                text: suggestion.text,
                remaining: entry.suggestions
            };
        }
        return null;
    }

    _read() {
        try {
            if (!this.filePath || !fs.existsSync(this.filePath)) return {};
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            this.logger?.warn?.(`Could not read suggestions: ${error.message}`);
            return {};
        }
    }

    _write(state) {
        try {
            const temporary = `${this.filePath}.${process.pid}.tmp`;
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
            fs.renameSync(temporary, this.filePath);
        } catch (error) {
            this.logger?.warn?.(`Could not persist suggestions: ${error.message}`);
        }
    }
}

/**
 * A suggestion is one short line the operator might say next. A real subagent
 * report is long, or has structure, and must not become a button that sends it.
 */
function looksLikeSuggestion(text) {
    const value = String(text ?? '').trim();
    if (!value || value.length > 120) return false;
    if (value.includes('\n') || value.includes('`')) return false;
    return true;
}

function suggestionKeyboard(entry, extraRows = []) {
    const rows = (entry?.suggestions || []).map(suggestion => [{
        text: `▶︎ ${suggestion.text}`.slice(0, 60),
        callback_data: `sug:${suggestion.id}`
    }]);
    return [...rows, ...extraRows];
}

module.exports = { SuggestionStore, looksLikeSuggestion, suggestionKeyboard, REPLY_WINDOW_MS };
