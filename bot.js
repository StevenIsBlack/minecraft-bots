const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const express = require('express');
const { pathfinder } = require('mineflayer-pathfinder');
const app = express();
app.use(express.json());

const bots = new Map();
const forceTargets = new Map();

const SERVER_HOST = process.env.MC_HOST || 'DonutSMP.net';
const SERVER_PORT = parseInt(process.env.MC_PORT || '25565');
const VERSION = process.env.MC_VERSION || '1.20.1';

// Extract username and create auth from Microsoft JWT token
async function createAuthFromToken(jwtToken) {
    try {
        // Decode JWT to get username
        const payload = JSON.parse(Buffer.from(jwtToken.split('.')[1], 'base64').toString());
        const username = payload.pfd?.[0]?.name || null;
        const uuid = payload.pfd?.[0]?.id || null;
        
        if (!username) {
            throw new Error('Could not extract username from token');
        }
        
        console.log(`Extracted username: ${username}, UUID: ${uuid}`);
        
        // Create a custom auth flow that uses the provided token
        const authflow = new Authflow(username, './auth_cache', {
            authTitle: Titles.MinecraftJava,
            flow: 'live',
            // Inject the existing Microsoft token
            getMsaToken: async () => ({
                token: jwtToken,
                expires_on: Date.now() + 86400000 // 24 hours
            })
        });
        
        return { authflow, username, uuid };
        
    } catch (e) {
        console.error('Token parse error:', e);
        throw new Error(`Invalid token format: ${e.message}`);
    }
}

function createBot(jwtToken, botId) {
    return new Promise(async (resolve, reject) => {
        console.log(`[${botId}] Processing authentication...`);
        
        let auth;
        try {
            auth = await createAuthFromToken(jwtToken);
        } catch (e) {
            return reject(e);
        }
        
        const mcUsername = auth.username;
        console.log(`[${botId}] MC Username: ${mcUsername}`);
        console.log(`[${botId}] Connecting to ${SERVER_HOST}:${SERVER_PORT} (${VERSION})`);

        let spawned = false;
        let bot;

        try {
            bot = mineflayer.createBot({
                host: SERVER_HOST,
                port: SERVER_PORT,
                version: VERSION,
                username: mcUsername,
                auth: 'microsoft',
                authflow: auth.authflow, // Use our custom authflow with token
                hideErrors: false,
                checkTimeoutInterval: 60000,
            });
            
            bot.loadPlugin(pathfinder);
            
        } catch (err) {
            return reject(new Error(`Bot creation failed: ${err.message}`));
        }

        const botData = {
            bot, id: botId, token: jwtToken,
            username: mcUsername, online: false,
            messageQueue: [], messageInterval: null,
            reconnectTimeout: null, lastMessage: 0
        };

        bot.once('spawn', () => {
            spawned = true;
            botData.username = bot.username;
            botData.online = true;
            console.log(`✅ [${botId}] ${botData.username} spawned!`);
            startMessagingCycle(botData);
            resolve(botData);
        });

        bot.on('error', (err) => {
            console.error(`❌ [${botId}] ${err.message}`);
            botData.online = false;
            if (!spawned) reject(err);
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
                    const newData = await createBot(jwtToken, botId);
                    bots.set(botId, newData);
                } catch (err) {
                    console.error(`[${botId}] Reconnect failed: ${err.message}`);
                }
            }, 30000);
        });

        setTimeout(() => {
            if (!spawned) {
                try { bot.quit(); } catch {}
                reject(new Error('Timeout - bot did not spawn'));
            }
        }, 60000);
    });
}

function startMessagingCycle(botData) {
    clearInterval(botData.messageInterval);
    botData.messageInterval = setInterval(() => {
        if (!botData.online) return;
        const now = Date.now();
        if (now - botData.lastMessage < 7000) return;
        
        const forceTarget = forceTargets.get('global');
        if (forceTarget) {
            sendMessage(botData, `/msg ${forceTarget} Hey! DonutMarket has cheap items!`);
            return;
        }
        
        if (botData.messageQueue.length > 0) {
            const target = botData.messageQueue.shift();
            sendMessage(botData, `/msg ${target} Hey! DonutMarket has cheap items!`);
        }
    }, 8000);
}

function sendMessage(botData, message) {
    try {
        if (botData.bot && botData.online) {
            botData.bot.chat(message);
            botData.lastMessage = Date.now();
        }
    } catch (err) {
        console.error(`[${botData.id}] Send failed: ${err.message}`);
    }
}

// API
app.post('/add', async (req, res) => {
    const { token, username } = req.body;
    const botId = username || `bot_${Date.now()}`;
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (bots.has(botId)) return res.status(400).json({ error: 'Bot exists' });
    
    try {
        const botData = await createBot(token, botId);
        bots.set(botId, botData);
        res.json({ success: true, botId, mcUsername: botData.username });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/remove', (req, res) => {
    const botData = bots.get(req.body.username);
    if (!botData) return res.status(404).json({ error: 'Not found' });
    clearTimeout(botData.reconnectTimeout);
    clearInterval(botData.messageInterval);
    try { botData.bot.quit(); } catch {}
    bots.delete(req.body.username);
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
app.listen(PORT, () => console.log(`🚀 Bot API on ${PORT} | ${SERVER_HOST}:${SERVER_PORT}`));
