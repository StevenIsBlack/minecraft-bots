const mc = require('minecraft-protocol');
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
        // Add padding if needed
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
        // Remove color codes and brackets
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
        console.log(`[${botId}] Starting bot...`);
        
        const { email, accessToken } = parseToken(sessionToken);
        console.log(`[${botId}] Parsed token for: ${email}`);
        
        // Decode the JWT to get Minecraft profile
        const tokenData = decodeJWT(accessToken);
        
        // Extract Minecraft profile from JWT
        const mcProfile = tokenData.profiles?.mc;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcProfile || !mcName) {
            throw new Error('Token missing Minecraft profile data. Token may be expired or invalid.');
        }
        
        console.log(`[${botId}] Minecraft Username: ${mcName}`);
        console.log(`[${botId}] UUID: ${mcProfile}`);
        
        // Check token expiration
        const expiresAt = new Date(tokenData.exp * 1000);
        const now = new Date();
        
        if (expiresAt < now) {
            throw new Error(`Token expired at ${expiresAt.toISOString()}`);
        }
        
        console.log(`[${botId}] Token valid until: ${expiresAt.toISOString()}`);
        console.log(`[${botId}] Connecting to ${host}:${port}...`);
        
        // Create the Minecraft client with the session token
        const client = mc.createClient({
            host: host,
            port: port,
            username: email,
            auth: 'microsoft',
            // Use the session directly - NO CONVERSION NEEDED!
            session: {
                accessToken: accessToken,
                clientToken: tokenData.aid || '00000000-0000-0000-0000-000000000000',
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                }
            },
            skipValidation: true,
            version: false, // Auto-detect server version
            hideErrors: false
        });
        
        // Bot state
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        
        client.on('login', () => {
            console.log(`✅ [${botId}] Successfully logged in as ${mcName}`);
            isOnline = true;
        });
        
        client.on('spawn_position', (packet) => {
            console.log(`🎮 [${botId}] Spawned at position`);
        });
        
        // Message queue system
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' 
                    ? JSON.parse(packet.message) 
                    : packet.message;
                    
                const msg = extractText(text);
                
                // Ignore own messages and auto-messages
                if (!msg || msg.includes('[AutoMsg]') || msg.includes('discord.gg')) {
                    return;
                }
                
                const name = parseName(msg, mcName);
                
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${botId}] 📥 Queued: ${name} (${queue.length} in queue)`);
                }
            } catch (e) {
                // Ignore parse errors
            }
        });
        
        // Auto-message sender
        const sender = setInterval(() => {
            if (!isOnline || !client.socket || !client.socket.writable) {
                return;
            }
            
            const now = Date.now();
            
            // Send message every 2 seconds if queue has players
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = generateRandom();
                const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
                
                try {
                    client.write('chat', { message });
                    console.log(`[${botId}] 📨 Sent to ${target} (${queue.length} remaining)`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    
                    // Remove from cooldown after 5 seconds
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (e) {
                    console.error(`[${botId}] Failed to send message:`, e.message);
                }
            }
        }, 100);
        
        client.on('kick_disconnect', (packet) => {
            clearInterval(sender);
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`🚫 [${botId}] Kicked: ${reason.text || 'Unknown reason'}`);
            } catch {
                console.error(`🚫 [${botId}] Kicked from server`);
            }
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            clearInterval(sender);
            try {
                const reason = JSON.parse(packet.reason);
                console.log(`[${botId}] Disconnected: ${reason.text || 'Connection closed'}`);
            } catch {
                console.log(`[${botId}] Disconnected`);
            }
            bots.delete(botId);
        });
        
        client.on('end', () => {
            clearInterval(sender);
            isOnline = false;
            console.log(`[${botId}] Connection ended`);
            bots.delete(botId);
        });
        
        client.on('error', (err) => {
            console.error(`❌ [${botId}] Error: ${err.message}`);
        });
        
        // Store bot info
        bots.set(botId, { 
            client, 
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
        console.error(`❌ [${botId}] Failed to create bot: ${error.message}`);
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
        
        console.log(`\n[API] Starting bot: ${username}`);
        const result = await createBot(username, host, port, token);
        
        res.json({ 
            success: true, 
            message: `Bot ${username} started`,
            ...result 
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, error: 'Missing username' });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    console.log(`[API] Stopping bot: ${username}`);
    bot.client.end('Stopped via API');
    bots.delete(username);
    
    res.json({ success: true, message: `Bot ${username} stopped` });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    
    if (!username || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing username or message' 
        });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    try {
        bot.client.write('chat', { message });
        console.log(`[API] Chat from ${username}: ${message}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    
    if (!username || !target) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing username or target' 
        });
    }
    
    const bot = bots.get(username);
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Bot not found' });
    }
    
    setTimeout(() => {
        const random = generateRandom();
        const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
        
        try {
            bot.client.write('chat', { message });
            console.log(`[${username}] 🎯 Force message sent to ${target}`);
        } catch (err) {
            console.error(`[${username}] Failed to send force message:`, err.message);
        }
    }, 1000);
    
    res.json({ success: true, message: `Sending to ${target}` });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcName,
        uuid: bot.uuid,
        connected: bot.client.socket?.writable || false,
        queueLength: bot.queue.length,
        cooldownCount: bot.cooldown.size,
        uptime: Math.floor((Date.now() - bot.startTime) / 1000)
    }));
    
    res.json({ 
        success: true, 
        count: bots.size, 
        bots: status 
    });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        bots: bots.size,
        uptime: process.uptime()
    });
});

app.get('/health', (req, res) => {
    res.json({ healthy: true, bots: bots.size });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM received, shutting down...');
    bots.forEach((bot, username) => {
        bot.client.end('Server shutting down');
    });
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('🚀 Minecraft Bot Manager v2.0');
    console.log(`✅ Running on port ${PORT}`);
    console.log(`📡 Ready for connections`);
    console.log('=================================');
});
