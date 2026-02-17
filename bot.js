const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
app.use(express.json());

const bots = new Map();
const botQueues = new Map();
const forceTargets = new Map();

const SERVER_HOST = 'DonutSMP.net';
const SERVER_PORT = 25565;
const VERSION = '1.20.1'; // Change to match DonutSMP's version

function createBot(token, botId) {
    return new Promise((resolve, reject) => {
        let bot;

        try {
            bot = mineflayer.createBot({
                host: SERVER_HOST,
                port: SERVER_PORT,
                version: VERSION,
                auth: 'mojang',          // Mojang token auth
                username: token,          // Mojang access token goes here
                logErrors: false,
                hideErrors: true,
                checkTimeoutInterval: 30000,
                connect: (client) => {
                    // Use the token directly for auth
                    client.session = {
                        accessToken: token,
                        selectedProfile: {
                            id: client.session?.selectedProfile?.id || '',
                            name: client.session?.selectedProfile?.name || 'Bot'
                        }
                    };
                }
            });
        } catch (err) {
            return reject(err);
        }

        const botData = {
            bot,
            id: botId,
            token,
            username: null,
            online: false,
            messageQueue: [],
            currentTarget: null,
            messageInterval: null,
            reconnectTimeout: null
        };

        bot.once('spawn', () => {
            botData.username = bot.username;
            botData.online = true;
            console.log(`✅ [${botId}] ${bot.username} spawned on DonutSMP`);
            
            // Start messaging queue
            startMessagingCycle(botData);
            resolve(botData);
        });

        bot.on('chat', (username, message) => {
            if (username === bot.username) return;
            console.log(`[${botId}] <${username}> ${message}`);
        });

        bot.on('error', (err) => {
            console.error(`[${botId}] Error:`, err.message);
            botData.online = false;
        });

        bot.on('end', (reason) => {
            console.log(`[${botId}] Disconnected: ${reason}`);
            botData.online = false;
            clearInterval(botData.messageInterval);
            
            // Auto reconnect after 30 seconds
            botData.reconnectTimeout = setTimeout(() => {
                console.log(`[${botId}] Reconnecting...`);
                createBot(token, botId).then(newBotData => {
                    bots.set(botId, newBotData);
                }).catch(err => {
                    console.error(`[${botId}] Reconnect failed:`, err.message);
                });
            }, 30000);
        });

        bot.on('kicked', (reason) => {
            console.log(`[${botId}] Kicked: ${reason}`);
            botData.online = false;
        });

        // Timeout if bot doesn't spawn in 30 seconds
        setTimeout(() => {
            if (!botData.online) {
                bot.quit();
                reject(new Error('Bot failed to spawn within 30 seconds'));
            }
        }, 30000);
    });
}

function startMessagingCycle(botData) {
    clearInterval(botData.messageInterval);
    
    botData.messageInterval = setInterval(() => {
        if (!botData.online || !botData.bot) return;

        // Check for force target first
        const forceTarget = forceTargets.get('global');
        if (forceTarget) {
            sendMessage(botData, `/msg ${forceTarget} Hi! We sell items on DonutSMP! Visit our shop!`);
            return;
        }

        // Process normal queue
        if (botData.messageQueue.length > 0) {
            const target = botData.messageQueue.shift();
            sendMessage(botData, `/msg ${target} Hi! We sell items on DonutSMP! Visit our shop!`);
        }
    }, 8000); // Message every 8 seconds (avoids spam detection)
}

function sendMessage(botData, message) {
    try {
        if (botData.bot && botData.online) {
            botData.bot.chat(message);
            console.log(`[${botData.id}] Sent: ${message}`);
        }
    } catch (err) {
        console.error(`[${botData.id}] Failed to send message:`, err.message);
    }
}

// ─── API ROUTES ─────────────────────────────────────────────────────────────

app.post('/add', async (req, res) => {
    const { token, username } = req.body;
    const botId = username || `bot_${Date.now()}`;

    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    if (bots.has(botId)) {
        return res.status(400).json({ error: `Bot ${botId} already exists` });
    }

    try {
        console.log(`[API] Adding bot ${botId}...`);
        const botData = await createBot(token, botId);
        bots.set(botId, botData);
        res.json({ 
            success: true, 
            botId, 
            mcUsername: botData.username,
            message: `Bot ${botData.username} joined DonutSMP!`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const botData = bots.get(username);

    if (!botData) {
        return res.status(404).json({ error: `Bot ${username} not found` });
    }

    clearTimeout(botData.reconnectTimeout);
    clearInterval(botData.messageInterval);
    botData.bot.quit('Removed by admin');
    bots.delete(username);

    res.json({ success: true, stopped: username });
});

app.post('/stopall', (req, res) => {
    let stopped = 0;
    bots.forEach((botData, botId) => {
        clearTimeout(botData.reconnectTimeout);
        clearInterval(botData.messageInterval);
        try { botData.bot.quit('Stopped by admin'); } catch {}
        stopped++;
    });
    bots.clear();
    forceTargets.clear();
    res.json({ success: true, stopped });
});

app.post('/forcemsg', (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ error: 'Target player required' });

    forceTargets.set('global', target);
    console.log(`[API] Force messaging: ${target}`);
    res.json({ success: true, sent: bots.size, target });
});

app.post('/stopforce', (req, res) => {
    const stopped = bots.size;
    forceTargets.clear();
    res.json({ success: true, stopped });
});

app.post('/addqueue', (req, res) => {
    const { targets } = req.body; // Array of player names
    if (!targets || !Array.isArray(targets)) {
        return res.status(400).json({ error: 'targets array required' });
    }

    let added = 0;
    bots.forEach((botData) => {
        targets.forEach(target => {
            botData.messageQueue.push(target);
            added++;
        });
    });

    res.json({ success: true, added });
});

app.get('/status', (req, res) => {
    const botList = [];
    bots.forEach((botData, botId) => {
        botList.push({
            id: botId,
            username: botData.username,
            online: botData.online,
            queueLength: botData.messageQueue.length
        });
    });

    res.json({
        online: botList.filter(b => b.online).length,
        total: bots.size,
        bots: botList,
        forceTarget: forceTargets.get('global') || null
    });
});

// ─── START SERVER ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Minecraft Bot API running on port ${PORT}`);
    console.log(`📡 Server: ${SERVER_HOST}:${SERVER_PORT}`);
    console.log(`🎮 Version: ${VERSION}`);
    console.log(`🔑 Auth: Mojang Token`);
});
