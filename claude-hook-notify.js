#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks to send Telegram notifications
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables from the project directory
const projectDir = path.dirname(__filename);
const envPath = path.join(projectDir, '.env');

console.log('🔍 Hook script started from:', process.cwd());
console.log('📁 Script location:', __filename);
console.log('🔧 Looking for .env at:', envPath);

if (fs.existsSync(envPath)) {
    console.log('✅ .env file found, loading...');
    dotenv.config({ path: envPath });
} else {
    console.error('❌ .env file not found at:', envPath);
    console.log('📂 Available files in script directory:');
    try {
        const files = fs.readdirSync(projectDir);
        console.log(files.join(', '));
    } catch (error) {
        console.error('Cannot read directory:', error.message);
    }
    process.exit(1);
}

const TelegramChannel = require('./src/channels/telegram/telegram');
const DesktopChannel = require('./src/channels/local/desktop');
const EmailChannel = require('./src/channels/email/smtp');

async function readHookInput() {
    if (process.stdin.isTTY) return {};

    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return {};

    try {
        return JSON.parse(raw);
    } catch (error) {
        console.error('⚠️ Could not parse Claude hook input:', error.message);
        return {};
    }
}

async function sendHookNotification() {
    try {
        console.log('🔔 Claude Hook: Sending notifications...');
        const hookInput = await readHookInput();
        
        // Get notification type from command line argument
        const notificationType = process.argv[2] || 'completed';
        
        const channels = [];
        const results = [];
        
        // Configure Desktop channel (always enabled for sound)
        const desktopChannel = new DesktopChannel({
            completedSound: 'Glass',
            waitingSound: 'Tink'
        });
        channels.push({ name: 'Desktop', channel: desktopChannel });
        
        // Configure Telegram channel if enabled
        if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                groupId: process.env.TELEGRAM_GROUP_ID
            };
            
            if (telegramConfig.botToken && (telegramConfig.chatId || telegramConfig.groupId)) {
                const telegramChannel = new TelegramChannel(telegramConfig);
                channels.push({ name: 'Telegram', channel: telegramChannel });
            }
        }
        
        // Configure Email channel if enabled
        if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
            const emailConfig = {
                smtp: {
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                },
                from: process.env.EMAIL_FROM,
                fromName: process.env.EMAIL_FROM_NAME,
                to: process.env.EMAIL_TO
            };
            
            if (emailConfig.smtp.host && emailConfig.smtp.auth.user && emailConfig.to) {
                const emailChannel = new EmailChannel(emailConfig);
                channels.push({ name: 'Email', channel: emailChannel });
            }
        }
        
        // Get current working directory and tmux session
        const currentDir = hookInput.cwd || process.cwd();
        const projectName = path.basename(currentDir);
        
        // Try to get current tmux session
        let tmuxSession = process.env.TMUX_SESSION || 'claude-real';
        try {
            const { execSync } = require('child_process');
            const sessionOutput = execSync('tmux display-message -p "#S"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (sessionOutput) {
                tmuxSession = sessionOutput;
            }
        } catch (error) {
            // Not in tmux or tmux not available, use default
        }
        
        // Create notification
        const notification = {
            type: notificationType,
            title: `Claude ${notificationType === 'completed' ? 'Task Completed' : 'Waiting for Input'}`,
            message: `Claude has ${notificationType === 'completed' ? 'completed a task' : 'is waiting for input'}`,
            project: projectName,
            metadata: {
                claudeResponse: hookInput.last_assistant_message || '',
                tmuxSession,
                directReply: Boolean(hookInput.last_assistant_message),
                sessionId: hookInput.session_id || null
            }
        };
        
        console.log(`📱 Sending ${notificationType} notification for project: ${projectName}`);
        console.log(`🖥️ Tmux session: ${tmuxSession}`);
        
        // Send notifications to all configured channels
        for (const { name, channel } of channels) {
            try {
                console.log(`📤 Sending to ${name}...`);
                const result = await channel.send(notification);
                results.push({ name, success: result });
                
                if (result) {
                    console.log(`✅ ${name} notification sent successfully!`);
                } else {
                    console.log(`❌ Failed to send ${name} notification`);
                }
            } catch (error) {
                console.error(`❌ ${name} notification error:`, error.message);
                results.push({ name, success: false, error: error.message });
            }
        }
        
        // Report overall results
        const successful = results.filter(r => r.success).length;
        const total = results.length;
        
        if (successful > 0) {
            console.log(`\n✅ Successfully sent notifications via ${successful}/${total} channels`);
            if (results.some(r => r.name === 'Telegram' && r.success)) {
                console.log('📋 You can now send new commands via Telegram');
            }
        } else {
            console.log('\n❌ All notification channels failed');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Hook notification error:', error.message);
        process.exit(1);
    }
}

// Show usage if no arguments
if (process.argv.length < 2) {
    console.log('Usage: node claude-hook-notify.js [completed|waiting]');
    process.exit(1);
}

sendHookNotification();
