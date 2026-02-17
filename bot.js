const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
app.use(express.json());

const bots = new Map();
const forceTargets = new Map();

const SERVER_HOST = process.env.MC_HOST || 'DonutSMP.net';
const SERVER_PORT = parseInt(process.env.MC_PORT || '25565');
const VERSION = process.env.MC_VERSION || '1.20.1';

// Token format can be:
// 1. "email:password:accessToken" → extract accessToken
// 2. Just the raw accessToken
function parseToken(input) {
    const parts = input.split(':');
    if (parts.length >= 3) {
        // email:password:token - return just the token (last part)
        return parts.slice(2).join(':');
    }
    return input;
}

function getBotUsername(accessToken) {
    // Decode JWT to get the username
    try {
        const payload = accessToken.split('.')[1];
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
        // Get username from pfd array
        if (decoded.pfd && decoded.pfd[0] && decoded.pfd[0].name) {
            return decoded.pfd[0].name;
        }
    } catch {}
    return null;
}

function createBot(rawToken, botId) {
    return new Promise((resolve, reject) => {
        const accessToken = parseToken(rawToken);
        const mcUsername = getBotUsername(accessToken) || `Bot_${botId}`;
        
        console.log(`[${botId}] Username from token: ${mcUsername}`);
        console.log(`[${botId}] Connecting to ${SERVER_HOST}:${SERVER_PORT} v${VERSION}...`);

        let bot;
        let spawned = false;

        try {
            bot = mineflayer.createBot({
                host: SERVER_HOST,
                port: SERVER_PORT,
                version: VERSION,
                auth: 'microsoft',
                username: mcUsername,
                profilesFolder: false,
                logErrors: true,
                hideErrors: false,
                checkTimeoutInterval: 60000,
            });

            // Inject access token directly into client before auth handshake
            bot._client.on('connect', () => {
                console.log(`[${botId}] TCP connected, injecting token...`);
                bot._client.session = {
                    accessToken: accessToken,
                    selectedProfile: {
                        id: '14cdeeae9e734f18aae8856ba7776654',
                        name: mcUsername
                    }
                };
            });

        } catch (err) {
            return reject(new Error(`Failed to create bot: ${err.message}`));
        }

        const botData = {
            bot, id: botId, token: rawToken,
            username: mcUsername, online: false,
            messageQueue: [], messageInterval: null, reconnectTimeout: null
        };

        bot.once('spawn', () => {
            spawned = true;
            botData.username = bot.username || mcUsername;
            botData.online = true;
            console.log(`✅ [${botId}] ${botData.username} spawned on DonutSMP!`);
            startMessagingCycle(botData);
            resolve(botData);
        });

        bot.on('error', (err) => {
            console.error(`❌ [${botId}] Error: ${err.message}`);
            botData.online = false;
            if (!spawned) reject(new Error(err.message));
        });

        bot.on('kicked', (reason) => {
            let msg = reason;
            try { msg = JSON.parse(reason)?.text || reason; } catch {}
            console.log(`⚠️ [${botId}] Kicked: ${msg}`);
            botData.online = false;
            if (!spawned) reject(new Error(`Kicked: ${msg}`));
        });

        bot.on('end', (reason) => {
            console.log(`🔌 [${botId}] Disconnected: ${reason}`);
            botData.online = false;
            clearInterval(botData.messageInterval);
            botData.reconnectTimeout = setTimeout(async () => {
                console.log(`🔄 [${botId}] Reconnecting...`);
                try {
                    const newBotData = await createBot(rawToken, botId);
                    bots.set(botId, newBotData);
                } catch (err) {
                    console.error(`[${botId}] Reconnect failed: ${err.message}`);
                }
            }, 30000);
        });

        setTimeout(() => {
            if (!spawned) {
                try { bot.quit(); } catch {}
                reject(new Error('Timed out after 45s - token may be expired'));
            }
        }, 45000);
    });
}

function startMessagingCycle(botData) {
    clearInterval(botData.messageInterval);
    botData.messageInterval = setInterval(() => {
        if (!botData.online) return;
        const forceTarget = forceTargets.get('global');
        if (forceTarget) {
            sendMessage(botData, `/msg ${forceTarget} Hey! Check out DonutMarket for cheap items!`);
            return;
        }
        if (botData.messageQueue.length > 0) {
            const target = botData.messageQueue.shift();
            sendMessage(botData, `/msg ${target} Hey! Check out DonutMarket for cheap items!`);
        }
    }, 8000);
}

function sendMessage(botData, message) {
    try {
        if (botData.bot && botData.online) botData.bot.chat(message);
    } catch (err) {
        console.error(`[${botData.id}] Send failed: ${err.message}`);
    }
}

app.post('/add', async (req, res) => {
    const { token, username } = req.body;
    const botId = username || `bot_${Date.now()}`;
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (bots.has(botId)) return res.status(400).json({ error: 'Bot already exists' });
    try {
        const botData = await createBot(token, botId);
        bots.set(botId, botData);
        res.json({ success: true, botId, mcUsername: botData.username });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const botData = bots.get(username);
    if (!botData) return res.status(404).json({ error: 'Not found' });
    clearTimeout(botData.reconnectTimeout);
    clearInterval(botData.messageInterval);
    try { botData.bot.quit(); } catch {}
    bots.delete(username);
    res.json({ success: true });
});

app.post('/stopall', (req, res) => {
    let stopped = 0;
    bots.forEach((b) => {
        clearTimeout(b.reconnectTimeout);
        clearInterval(b.messageInterval);
        try { b.bot.quit(); } catch {}
        stopped++;
    });
    bots.clear();
    forceTargets.clear();
    res.json({ success: true, stopped });
});

app.post('/forcemsg', (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ error: 'Target required' });
    forceTargets.set('global', target);
    res.json({ success: true, sent: bots.size });
});

app.post('/stopforce', (req, res) => {
    forceTargets.clear();
    res.json({ success: true, stopped: bots.size });
});

app.get('/status', (req, res) => {
    const botList = [];
    bots.forEach((b, id) => botList.push({ id, username: b.username, online: b.online }));
    res.json({ online: botList.filter(b => b.online).length, total: bots.size, bots: botList });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot API running | ${SERVER_HOST}:${SERVER_PORT} v${VERSION}`));
