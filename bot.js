const mineflayer = require('mineflayer');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();

function parseToken(tokenString) {
    const parts = tokenString.split(':');
    if (parts.length < 3) throw new Error('Invalid token format');
    return {
        email: parts[0],
        password: parts[1],
        accessToken: parts.slice(2).join(':')
    };
}

function decodeJWT(token) {
    try {
        token = token.trim();
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid JWT structure');
        
        let payload = parts[1];
        while (payload.length % 4 !== 0) payload += '=';
        
        return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (e) {
        throw new Error('JWT decode failed: ' + e.message);
    }
}

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    let text = component.text || '';
    if (component.extra) component.extra.forEach(e => text += extractText(e));
    return text;
}

function parseName(text, myName) {
    if (!text.includes(':')) return null;
    
    try {
        let name = text.substring(0, text.indexOf(':')).trim();
        name = name.replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
        if (name.endsWith('+')) name = name.substring(0, name.length - 1);
        if (name.includes(' ')) name = name.substring(name.lastIndexOf(' ') + 1);
        if (name.length < 3 || name.length > 16) return null;
        if (name.toLowerCase() === myName.toLowerCase()) return null;
        return name;
    } catch {
        return null;
    }
}

function generateRandom() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const len = 5 + Math.floor(Math.random() * 5);
    let result = '';
    for (let i = 0; i < len * 2 + 1; i++) {
        if (i === len) {
            result += ' ';
        } else {
            result += chars[Math.floor(Math.random() * chars.length)];
        }
    }
    return result;
}

async function createBot(botId, host, port, sessionToken) {
    try {
        console.log(`\n[${botId}] Starting bot...`);
        
        const { email, accessToken } = parseToken(sessionToken);
        console.log(`[${botId}] Email: ${email}`);
        
        // Decode the JWT
        const tokenData = decodeJWT(accessToken);
        
        // Check what type of profile this is
        console.log(`[${botId}] Checking token type...`);
        
        // Look for Java profile specifically
        const mcProfile = tokenData.profiles?.mc;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcProfile || !mcName) {
            throw new Error('Token missing Minecraft Java profile. This may be a Bedrock/Console-only account.');
        }
        
        console.log(`[${botId}] Java Profile Found:`);
        console.log(`[${botId}]   Username: ${mcName}`);
        console.log(`[${botId}]   UUID: ${mcProfile}`);
        
        // Check expiration
        const expiresAt = new Date(tokenData.exp * 1000);
        if (expiresAt < new Date()) {
            throw new Error(`Token expired at ${expiresAt.toISOString()}`);
        }
        console.log(`[${botId}]   Expires: ${expiresAt.toISOString()}`);
        
        // Check if this is an Xbox token (Bedrock indicator)
        if (tokenData.xuid) {
            console.log(`[${botId}] ⚠️  WARNING: Token contains XUID - may be Bedrock/Console token`);
        }
        
        console.log(`[${botId}] Connecting to ${host}:${port} as JAVA EDITION...`);
        
        // Use Mineflayer with STRICT Java authentication
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: email,
            auth: 'microsoft',
            // Force Java Edition session
            session: {
                accessToken: accessToken,
                clientToken: tokenData.aid || '00000000-0000-0000-0000-000000000000',
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                },
                // Add profile array to ensure Java authentication
                availableProfiles: [{
                    id: mcProfile,
                    name: mcName
                }]
            },
            skipValidation: true,
            version: false, // Let server dictate version
            hideErrors: false,
            // CRITICAL: These settings help ensure Java Edition
            checkTimeoutInterval: 30000,
            viewDistance: 'tiny'
        });
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let loginAttempts = 0;
        
        bot.on('login', () => {
            loginAttempts++;
            console.log(`✅ [${botId}] Login successful (attempt ${loginAttempts})`);
            console.log(`✅ [${botId}] Connected as: ${bot.username}`);
            isOnline = true;
        });
        
        bot.on('spawn', () => {
            console.log(`🎮 [${botId}] Spawned in game!`);
            console.log(`🎮 [${botId}] Dimension: ${bot.game?.dimension || 'unknown'}`);
            console.log(`🎮 [${botId}] Game mode: ${bot.game?.gameMode || 'unknown'}`);
            
            // Verify this is Java by checking dimension format
            if (bot.game?.dimension) {
                const dim = bot.game.dimension;
                if (dim.includes('minecraft:') || dim === 'overworld' || dim === 'the_nether' || dim === 'the_end') {
                    console.log(`✅ [${botId}] CONFIRMED: Java Edition (dimension: ${dim})`);
                } else {
                    console.log(`⚠️  [${botId}] WARNING: Unexpected dimension format: ${dim}`);
                }
            }
        });
        
        // Chat message handler
        bot.on('message', (message) => {
            try {
                const msg = message.toString();
                
                if (!msg || msg.includes('[AutoMsg]') || msg.includes('discord.gg')) {
                    return;
                }
                
                const name = parseName(msg, bot.username);
                
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${botId}] 📥 Queued: ${name} (${queue.length} total)`);
                }
            } catch (e) {
                // Ignore errors
            }
        });
        
        // Auto-message sender
        const sender = setInterval(() => {
            if (!isOnline || !bot.player) {
                return;
            }
            
            const now = Date.now();
            
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = generateRandom();
                const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
                
                try {
                    bot.chat(message);
                    console.log(`[${botId}] 📨 Sent to ${target} (${queue.length} remaining)`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (e) {
                    console.error(`[${botId}] Send failed:`, e.message);
                }
            }
        }, 100);
        
        bot.on('kicked', (reason) => {
            clearInterval(sender);
            console.error(`🚫 [${botId}] Kicked: ${reason}`);
            
            // Check if kicked for being already online (good sign - means Java works)
            if (reason.includes('already online')) {
                console.log(`✅ [${botId}] Account is valid Java Edition (kicked for duplicate login)`);
            }
            
            bots.delete(botId);
        });
        
        bot.on('end', (reason) => {
            clearInterval(sender);
            isOnline = false;
            console.log(`[${botId}] Connection ended: ${reason || 'unknown'}`);
            bots.delete(botId);
        });
        
        bot.on('error', (err) => {
            console.error(`❌ [${botId}] Error: ${err.message}`);
        });
        
        // Store bot
        bots.set(botId, { 
            bot,
            mcName, 
            uuid: mcProfile,
            queue, 
            cooldown,
            startTime: Date.now()
        });
        
        return { 
            success: true, 
            mcUsername: mcName, 
            uuid: mcProfile 
        };
        
    } catch (error) {
        console.error(`❌ [${botId}] Failed: ${error.message}`);
        throw error;
    }
}

// API Endpoints
app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        
        if (!username || !token) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing username or token' 
            });
        }
        
        if (bots.has(username)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Bot already running' 
            });
        }
        
        const result = await createBot(username, host, port, token);
        res.json({ success: true, ...result });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const botData = bots.get(username);
    
    if (!botData) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    botData.bot.quit('Stopped via API');
    bots.delete(username);
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const botData = bots.get(username);
    
    if (!botData) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    try {
        botData.bot.chat(message);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    const botData = bots.get(username);
    
    if (!botData) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    setTimeout(() => {
        const random = generateRandom();
        const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
        
        try {
            botData.bot.chat(message);
            console.log(`[${username}] 🎯 Force sent to ${target}`);
        } catch (err) {
            console.error(`[${username}] Force send failed`);
        }
    }, 1000);
    
    res.json({ success: true, message: `Sending to ${target}` });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, botData]) => ({
        username,
        mcUsername: botData.mcName,
        uuid: botData.uuid,
        connected: botData.bot.player !== null && botData.bot.player !== undefined,
        health: botData.bot.health || 0,
        food: botData.bot.food || 0,
        queueLength: botData.queue.length,
        cooldownCount: botData.cooldown.size,
        uptime: Math.floor((Date.now() - botData.startTime) / 1000)
    }));
    
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => {
    res.json({ status: 'online', bots: bots.size });
});

app.get('/health', (req, res) => {
    res.json({ healthy: true, bots: bots.size });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    bots.forEach((botData) => {
        botData.bot.quit('Server shutdown');
    });
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('🚀 Minecraft Bot Manager v3.0');
    console.log('📡 JAVA EDITION ONLY');
    console.log(`✅ Running on port ${PORT}`);
    console.log('=================================');
});
