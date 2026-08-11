/**
 * Controller Injector
 * Injects commands into tmux sessions or PTY
 */

const { execSync, execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Logger = require('../core/logger');

class ControllerInjector {
    constructor(config = {}) {
        this.logger = new Logger('ControllerInjector');
        this.mode = config.mode || process.env.INJECTION_MODE || 'pty';
        this.defaultSession = config.defaultSession || process.env.TMUX_SESSION || 'claude-code';
    }

    async injectCommand(command, sessionName = null) {
        const session = sessionName || this.defaultSession;
        
        if (this.mode === 'tmux') {
            return this._injectTmux(command, session);
        } else {
            return this._injectPty(command, session);
        }
    }

    _injectTmux(command, sessionName) {
        try {
            // Check if tmux session exists
            try {
                execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
            } catch (error) {
                throw new Error(`Tmux session '${sessionName}' not found`);
            }

            // Literal mode prevents tmux from interpreting command text as key names.
            execFileSync('tmux', ['send-keys', '-t', sessionName, '-l', command]);
            execFileSync('tmux', ['send-keys', '-t', sessionName, 'Enter']);
            
            this.logger.info(`Command injected to tmux session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via tmux:', error.message);
            throw error;
        }
    }

    sendKey(key, sessionName = null) {
        const session = sessionName || this.defaultSession;
        const allowedKeys = new Set(['C-c', 'Escape']);

        if (this.mode !== 'tmux') {
            throw new Error('Control keys are only supported in tmux mode');
        }
        if (!allowedKeys.has(key)) {
            throw new Error(`Control key '${key}' is not allowed`);
        }

        try {
            execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
            execFileSync('tmux', ['send-keys', '-t', session, key]);
            this.logger.info(`Control key sent to tmux session '${session}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject control key via tmux:', error.message);
            throw new Error(`Tmux session '${session}' not found or unavailable`);
        }
    }

    getSessionInfo(sessionName = null) {
        const session = sessionName || this.defaultSession;
        if (this.mode !== 'tmux') {
            return { running: false, session, mode: this.mode };
        }

        try {
            // display-message can exit successfully with empty output for a
            // missing target, so existence must be checked explicitly first.
            execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
            const output = execFileSync(
                'tmux',
                ['display-message', '-p', '-t', session, '-F', '#{session_name}\t#{pane_current_path}\t#{pane_current_command}'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            const [name, cwd, command] = output.split('\t');
            if (!name || !cwd) return { running: false, session, mode: this.mode };
            return { running: true, session: name, cwd, command, mode: this.mode };
        } catch (error) {
            return { running: false, session, mode: this.mode };
        }
    }

    createSession(sessionName, cwd, claudeCliPath) {
        if (this.mode !== 'tmux') {
            throw new Error('New sessions are only supported in tmux mode');
        }
        if (!/^[A-Za-z0-9_-]+$/.test(sessionName)) {
            throw new Error('Invalid tmux session name');
        }
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
            throw new Error(`Project directory does not exist: ${cwd}`);
        }
        if (this.getSessionInfo(sessionName).running) {
            throw new Error(`Tmux session '${sessionName}' already exists`);
        }

        try {
            execFileSync(
                'tmux',
                ['new-session', '-d', '-s', sessionName, '-c', cwd, claudeCliPath],
                { stdio: 'ignore' }
            );
            this.logger.info(`Created tmux session '${sessionName}' in '${cwd}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to create tmux session:', error.message);
            throw new Error(`Could not create tmux session '${sessionName}'`);
        }
    }

    capturePane(sessionName = null, lines = 100) {
        const session = sessionName || this.defaultSession;
        if (this.mode !== 'tmux') return '';

        try {
            return execFileSync(
                'tmux',
                ['capture-pane', '-p', '-t', session, '-S', `-${Math.max(20, Math.min(lines, 300))}`],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            );
        } catch (error) {
            return '';
        }
    }

    selectOption(option, sessionName = null) {
        const session = sessionName || this.defaultSession;
        const index = Number(option);
        if (this.mode !== 'tmux') {
            throw new Error('Interactive choices are only supported in tmux mode');
        }
        if (!Number.isInteger(index) || index < 1 || index > 3) {
            throw new Error('Permission option must be between 1 and 3');
        }

        try {
            execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
            // Normalize to the first choice regardless of the current cursor.
            execFileSync('tmux', ['send-keys', '-t', session, 'Up', 'Up', 'Up']);
            if (index > 1) {
                execFileSync('tmux', ['send-keys', '-t', session, ...Array(index - 1).fill('Down')]);
            }
            execFileSync('tmux', ['send-keys', '-t', session, 'Enter']);
            this.logger.info(`Interactive option ${index} selected in tmux session '${session}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to select tmux option:', error.message);
            throw new Error(`Could not answer the prompt in tmux session '${session}'`);
        }
    }

    /**
     * The pane as the user sees it, with no scrollback.
     *
     * Mode detection reads a footer hint that Claude repaints on every mode
     * change, so the same words are all over the history: matching against
     * scrollback reports whichever mode the session used to be in.
     */
    captureVisible(sessionName = null, lines = 8) {
        const session = sessionName || this.defaultSession;
        if (this.mode !== 'tmux') return '';

        try {
            const visible = execFileSync(
                'tmux',
                ['capture-pane', '-p', '-t', session],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            );
            return visible.split('\n').filter(line => line.trim()).slice(-lines).join('\n');
        } catch (error) {
            return '';
        }
    }

    getPermissionMode(sessionName = null) {
        const footer = this.captureVisible(sessionName);
        if (!footer) return null;
        if (/accept edits on/i.test(footer)) return 'acceptEdits';
        if (/plan mode on/i.test(footer)) return 'plan';
        if (/auto mode on/i.test(footer)) return 'auto';
        if (/manual mode on/i.test(footer)) return 'default';
        // Ask mode paints no hint once the transient one fades, so an input box
        // with no hint is Ask -- not an unreadable session. Reporting it as
        // unreadable is what made a mode change on an idle session fail with
        // "not at an input prompt".
        if (this.isAtInputPrompt(footer)) return 'default';
        return null;
    }

    isAtInputPrompt(footer = null) {
        const visible = footer === null ? this.captureVisible() : footer;
        // Only Claude's own prompt glyph and its cycle hint count. A bare '>' is
        // ordinary output -- a diff, a quote, a shell transcript -- and reading
        // that as an input prompt would start cycling modes on a session that is
        // not showing one.
        return /(^|\n)\s*❯/.test(visible) || /shift\+tab to cycle/i.test(visible);
    }

    async selectPermissionMode(targetMode, sessionName = null) {
        const session = sessionName || this.defaultSession;
        const allowedModes = new Set(['default', 'acceptEdits', 'plan', 'auto']);
        if (this.mode !== 'tmux') {
            throw new Error('Permission modes are only supported in tmux mode');
        }
        if (!allowedModes.has(targetMode)) {
            throw new Error(`Permission mode '${targetMode}' is not allowed`);
        }

        if (!this.getPermissionMode(session)) {
            // Say which of the two things actually went wrong. The old message
            // blamed the input prompt for every unreadable footer, including a
            // session that was simply not running.
            if (!this.getSessionInfo(session).running) {
                throw new Error(`Claude session '${session}' is not running`);
            }
            throw new Error(`Could not read the permission mode of '${session}'`);
        }

        // Four modes plus slack for a repaint that lands between two reads.
        let unreadable = 0;
        for (let attempt = 0; attempt < 8; attempt++) {
            const currentMode = this.getPermissionMode(session);
            if (currentMode === targetMode) return targetMode;
            if (!currentMode) {
                // Mid-repaint the footer can come back empty; that is a reason
                // to look again, not to give up on the change.
                if (++unreadable > 2) {
                    throw new Error(`Could not read the permission mode of '${session}'`);
                }
                await new Promise(resolve => setTimeout(resolve, 250));
                continue;
            }

            try {
                execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
                // Claude's Shift+Tab sequence. Sending the explicit terminal
                // sequence is more reliable through tmux than the BTab key name.
                execFileSync('tmux', ['send-keys', '-t', session, 'Escape', '[', 'Z']);
            } catch (error) {
                throw new Error(`Could not switch mode in tmux session '${session}'`);
            }
            await new Promise(resolve => setTimeout(resolve, 350));
        }

        const finalMode = this.getPermissionMode(session);
        if (finalMode === targetMode) return targetMode;
        throw new Error(`Mode '${targetMode}' is unavailable in this Claude session`);
    }

    _injectPty(command, sessionName) {
        try {
            // Find PTY session file
            const sessionMapPath = process.env.SESSION_MAP_PATH || 
                                   path.join(__dirname, '../data/session-map.json');
            
            if (!fs.existsSync(sessionMapPath)) {
                throw new Error('Session map file not found');
            }

            const sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
            const sessionInfo = sessionMap[sessionName];
            
            if (!sessionInfo || !sessionInfo.ptyPath) {
                throw new Error(`PTY session '${sessionName}' not found`);
            }

            // Write command to PTY
            fs.writeFileSync(sessionInfo.ptyPath, command + '\n');
            
            this.logger.info(`Command injected to PTY session '${sessionName}'`);
            return true;
        } catch (error) {
            this.logger.error('Failed to inject command via PTY:', error.message);
            throw error;
        }
    }

    listSessions() {
        if (this.mode === 'tmux') {
            try {
                const output = execSync('tmux list-sessions -F "#{session_name}"', { 
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                return output.trim().split('\n').filter(Boolean);
            } catch (error) {
                return [];
            }
        } else {
            try {
                const sessionMapPath = process.env.SESSION_MAP_PATH || 
                                       path.join(__dirname, '../data/session-map.json');
                
                if (!fs.existsSync(sessionMapPath)) {
                    return [];
                }

                const sessionMap = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'));
                return Object.keys(sessionMap);
            } catch (error) {
                return [];
            }
        }
    }
}

module.exports = ControllerInjector;
