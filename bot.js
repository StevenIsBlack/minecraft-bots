const mineflayer = require('mineflayer');
const express = require('express');
const { pathfinder } = require('mineflayer-pathfinder');
const app = express();
app.use(express.json());

const bots = new Map();
const forceTargets = new Map();

const SERVER_HOST = process.env.MC_HOST || 'DonutSMP.net';
const SERVER_PORT = parseInt(process.env.MC_PORT || '25565');
const VERSION = process.env.MC_VERSION || '1.20.1';

// Parse the token format: "email:password:accessToken" OR just "accessToken"
function parseAuthString(authString) {
    // First, try to decode as JWT to get username
    let username = null;
    let tokenPart = authString;
    
    // Check if it's the full format with email:password:token
    if (authString.includes('@') && authString.split(':').length >= 3) {
        const parts = authString.split(':');
        tokenPart = parts.slice(2).join(':'); // Token is everything after email:password
    }
    
    // Now decode the JWT token to extract username
    try {
        // JWT format: header.payload.signature
        const parts = tokenPart.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
            console.log('JWT decoded successfully');
            
            // Extract username from pfd array
            if (payload.pfd && payload.pfd[0] && payload.pfd[0].name) {
                username = payload.pfd[0].name;
                console.log('Found username in JWT:', username);
            }
        }
    } catch (e) {
        console.error('Failed to decode JWT:', e.message);
    }
    
    return { username, token: tokenPart };
}

function createBot(authString, botId) {
    return new Promise((resolve, reject) => {
        const auth = parseAuthString(authString);
        const mcUsername = auth.username || `Bot_${botId}`;
        
        console.log(`[${botId}] Minecraft Username: ${mcUsername}`);
        console.log(`[${botId}] Connecting to ${SERVER_HOST}:${SERVER_PORT} (${VERSION})`);

        let spawned = false;
        let bot;

        try {
            // Critical: Use the exact mineflayer setup
            const botOptions = {
                host: SERVER_HOST,
                port: SERVER_PORT,
                version: VERSION,
                username: mcUsername,
                // Key: DonutSMP accepts offline mode with valid usernames
                auth: 'offline',
                hideErrors: false,
                checkTimeoutInterval: 60000,
                // Client brand for better compatibility
                brand: 'vanilla',
            };

            bot = mineflayer.createBot(botOptions);
            
            // Load pathfinder for movement (matches your friend's setup)
            bot.loadPlugin(pathfinder);
            
        } catch (err) {
            return reject(new Error(`Failed to create bot: ${err.message}`));
        }

        const botData = {
            bot,
            id: botId,
            auth: authString,
            username: mcUsername,
            online: false,
            messageQueue: [],
            messageInterval: null,
            reconnectTimeout: null,
            lastMessage: 0
        };

        bot.once('spawn', () => {
            spawned = true;
            botData.username = bot.username;
            botData.online = true;
            console.log(`✅ [${botId}] ${botData.username} spawned on DonutSMP!`);
            console.log(`   Position: ${bot.entity.position}`);
            console.log(`   Health: ${bot.health}`);
            
            startMessagingCycle(botData);
            resolve(botData);
        });

        bot.on('chat', (username, message) => {
            if (username === bot.username) return;
            console.log(`[${botId}] <${username}> ${message}`);
        });

        bot.on('error', (err) => {
            console.error(`❌ [${botId}] Error: ${err.message}`);
            botData.online = false;
            if (!spawned) reject(new Error(err.message));
        });

        bot.on('kicked', (reason) => {
            let msg = reason;
            try {
                const parsed = JSON.parse(reason);
                msg = parsed.text || parsed.translate || reason;
            } catch {}
            console.log(`⚠️ [${botId}] Kicked: ${msg}`);
            botData.online = false;
            if (!spawned) reject(new Error(`Kicked: ${msg}`));
        });

        bot.on('end', (reason) => {
            console.log(`🔌 [${botId}] Disconnected: ${reason}`);
            botData.online = false;
            clearInterval(botData.messageInterval);
            
            // Auto-reconnect after 30 seconds
            botData.reconnectTimeout = setTimeout(async () => {
                console.log(`🔄 [${botId}] Reconnecting...`);
                try {
                    const newData = await createBot(authString, botId);
                    bots.set(botId, newData);
                } catch (err) {
                    console.error(`[${botId}] Reconnect failed: ${err.message}`);
                }
            }, 30000);
        });

        bot.on('health', () => {
            if (bot.health <= 0) {
                console.log(`☠️ [${botId}] Died, respawning...`);
                bot.chat('/spawn');
            }
        });

        // Timeout if not spawned in 45 seconds
        setTimeout(() => {
            if (!spawned) {
                try { bot.quit(); } catch {}
                reject(new Error('Connection timeout - bot did not spawn in 45 seconds'));
            }
        }, 45000);
    });
}

function startMessagingCycle(botData) {
    clearInterval(botData.messageInterval);
    
    // Message every 8 seconds (avoids spam kick)
    botData.messageInterval = setInterval(() => {
        if (!botData.online || !botData.bot) return;
        
        const now = Date.now();
        if (now - botData.lastMessage < 7000) return; // Rate limit
        
        // Check for force target
        const forceTarget = forceTargets.get('global');
        if (forceTarget) {
            sendMessage(botData, `/msg ${forceTarget} Hey! Check out DonutMarket for cheap items!`);
            return;
        }
        
        // Process queue
        if (botData.messageQueue.length > 0) {
            const target = botData.messageQueue.shift();
            sendMessage(botData, `/msg ${target} Hey! Check out DonutMarket for cheap items!`);
        }
    }, 8000);
}

function sendMessage(botData, message) {
    try {
        if (botData.bot && botData.online) {
            botData.bot.chat(message);
            botData.lastMessage = Date.now();
            console.log(`[${botData.id}] → ${message}`);
        }
    } catch (err) {
        console.error(`[${botData.id}] Send failed: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

app.post('/add', async (req, res) => {
    const { token, username } = req.body;
    const botId = username || `bot_${Date.now()}`;
    
    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }
    
    if (bots.has(botId)) {
        return res.status(400).json({ error: `Bot ${botId} already exists` });
    }
    
    console.log(`[API] Adding bot ${botId}...`);
    
    try {
        const botData = await createBot(token, botId);
        bots.set(botId, botData);
        res.json({ 
            success: true, 
            botId, 
            mcUsername: botData.username,
            message: `Bot ${botData.username} joined DonutSMP!`
        });
    } catch (err) {
        console.error(`[API] Failed to add bot:`, err);
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
    try { botData.bot.quit('Removed by admin'); } catch {}
    bots.delete(username);
    
    res.json({ success: true, stopped: username });
});

app.post('/stopall', (req, res) => {
    let stopped = 0;
    bots.forEach((botData, botId) => {
        clearTimeout(botData.reconnectTimeout);
        clearInterval(botData.messageInterval);
        try { botData.bot.quit('Stopped all bots'); } catch {}
        stopped++;
    });
    bots.clear();
    forceTargets.clear();
    
    res.json({ success: true, stopped });
});

app.post('/forcemsg', (req, res) => {
    const { target } = req.body;
    
    if (!target) {
        return res.status(400).json({ error: 'Target player required' });
    }
    
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
    const { targets } = req.body;
    
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
            queueLength: botData.messageQueue.length,
            position: botData.bot?.entity?.position?.toString() || 'N/A'
        });
    });
    
    res.json({
        online: botList.filter(b => b.online).length,
        total: bots.size,
        bots: botList,
        forceTarget: forceTargets.get('global') || null
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`╔════════════════════════════════════════╗`);
    console.log(`║  🚀 DonutSMP Bot API                  ║`);
    console.log(`║  📡 Port: ${PORT.toString().padEnd(28)} ║`);
    console.log(`║  🎮 Server: ${SERVER_HOST.padEnd(23)} ║`);
    console.log(`║  📦 Version: ${VERSION.padEnd(22)} ║`);
    console.log(`╚════════════════════════════════════════╝`);
});
