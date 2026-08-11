/**
 * Panel view: state in, one Telegram message out.
 *
 * Deliberately pure. The panel used to be eleven call sites that each sent
 * their own message, which is why the chat piled up: nothing owned "the panel"
 * as a thing with an identity, so every action could only append. Here the
 * whole panel -- root, submenus, the status line -- is one function of state,
 * and `MessageAnchor` is what decides which message it lands in.
 */

const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODES = [
    { label: 'Ask', mode: 'default' },
    { label: 'Edits', mode: 'acceptEdits' },
    { label: 'Plan', mode: 'plan' },
    { label: 'Auto', mode: 'auto' }
];

const MODE_LABELS = Object.fromEntries(MODES.map(({ label, mode }) => [mode, label]));

const BACK = { text: '‹ Back', callback_data: 'ctl:v:root' };

function chunk(buttons, perRow) {
    const rows = [];
    for (let index = 0; index < buttons.length; index += perRow) {
        rows.push(buttons.slice(index, index + perRow));
    }
    return rows;
}

function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * @param {Object} state
 * @param {'root'|'model'|'effort'|'session'|'mode'} state.view
 * @param {string} state.sessionLabel   Human name of the selected session.
 * @param {string} [state.status]       Result of the last action, one line.
 * @param {Array<{selector: string, label: string, active: boolean}>} [state.sessions]
 * @param {string|null} [state.activeMode]
 * @returns {{text: string, reply_markup: Object}}
 */
function renderPanel(state) {
    const { view = 'root', sessionLabel, status = '', sessions = [], activeMode = null } = state;

    let heading;
    let rows;

    if (view === 'model') {
        heading = `🤖 Model · ${sessionLabel}`;
        rows = [
            MODELS.map(model => ({ text: capitalize(model), callback_data: `ctl:m:${model}` })),
            [BACK]
        ];
    } else if (view === 'effort') {
        heading = `🧠 Effort · ${sessionLabel}`;
        rows = [
            ...chunk(EFFORTS.map(effort => ({
                text: effort === 'xhigh' ? 'XHigh' : capitalize(effort),
                callback_data: `ctl:e:${effort}`
            })), 3),
            [BACK]
        ];
    } else if (view === 'session') {
        heading = `🖥 Session · ${sessionLabel}`;
        rows = [
            ...chunk(sessions.map(session => ({
                text: `${session.active ? '✓ ' : ''}${session.label}`,
                callback_data: `ctl:s:${session.selector}`
            })), 2),
            [{ text: '➕ New', callback_data: 'ctl:new' }, BACK]
        ];
    } else if (view === 'mode') {
        heading = `🛡 Mode · ${sessionLabel}`;
        rows = [
            MODES.map(({ label, mode }) => ({
                text: `${activeMode === mode ? '✓ ' : ''}${label}`,
                callback_data: `ctl:o:${mode}`
            })),
            [BACK]
        ];
    } else {
        heading = `🎛 ${sessionLabel}`;
        rows = [
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
    }

    // The status line lives inside the panel rather than in a message of its
    // own: an action that reports itself by appending is an action that pushes
    // the controls out of reach.
    const text = status ? `${heading}\n${status}` : heading;
    return { text, reply_markup: { inline_keyboard: rows } };
}

module.exports = { renderPanel, MODELS, EFFORTS, MODES, MODE_LABELS };
