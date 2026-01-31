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
        if (parts.length !== 3) throw new Error('Invalid JWT');
        
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
        
        const tokenData = decodeJWT(accessToken);
        
        const mcProfile = tokenData.profiles?.mc;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcProfile || !mcName) {
            throw new Error('Missing Java profile in token');
        }
        
        console.log(`[${botId}] Username: ${mcName}`);
        console.log(`[${botId}] UUID: ${mcProfile}`);
        
        const expiresAt = new Date(tokenData.exp * 1000);
        if (expiresAt < new Date()) {
            throw new Error('Token expired');
        }
        
        console.log(`[${botId}] Connecting to ${host}:${port}...`);
        
        // Use minecraft-protocol with explicit session and NO auth
        const client = mc.createClient({
            host: host,
            port: port,
            // CRITICAL: Use the MC username, not email
            username: mcName,
            // CRITICAL: Set auth to false to prevent any authentication
            auth: false,
            // Provide session for encryption
            session: {
                accessToken: accessToken,
                clientToken: tokenData.aid || 'nodejs',
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                }
            },
            // Force Java protocol
            version: false,
            hideErrors: false
        });
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        
        client.on('success', () => {
            console.log(`✅ [${botId}] Authentication successful!`);
        });
        
        client.on('login', (packet) => {
            console.log(`✅ [${botId}] Logged in!`);
            console.log(`✅ [${botId}] Entity ID: ${packet.entityId}`);
            isOnline = true;
        });
        
        client.on('spawn_position', () => {
            console.log(`🎮 [${botId}] Spawned in game!`);
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const msg = extractText(text);
                
                if (!msg || msg.includes('[AutoMsg]') || msg.includes('discord.gg')) {
                    return;
                }
                
                const name = parseName(msg, mcName);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${botId}] 📥 Queued: ${name}`);
                }
            } catch {}
        });
        
        const sender = setInterval(() => {
            if (!isOnline || !client.socket || !client.socket.writable) return;
            
            const now = Date.now();
            
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = generateRandom();
                const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
                
                try {
                    client.write('chat', { message });
                    console.log(`[${botId}] 📨 → ${target}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch {}
            }
        }, 100);
        
        client.on('kick_disconnect', (packet) => {
            clearInterval(sender);
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`🚫 [${botId}] Kicked: ${reason.text || reason}`);
            } catch {
                console.error(`🚫 [${botId}] Kicked: ${packet.reason}`);
            }
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            clearInterval(sender);
            try {
                const reason = JSON.parse(packet.reason);
                console.log(`[${botId}] Disconnected: ${reason.text || reason}`);
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
            console.error(`❌ [${botId}] ${err.message}`);
        });
        
        bots.set(botId, { client, mcName, queue, cooldown });
        
        return { success: true, mcUsername: mcName, uuid: mcProfile };
        
    } catch (error) {
        console.error(`❌ [${botId}] Failed: ${error.message}`);
        throw error;
    }
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        
        if (!username || !token) {
            return res.status(400).json({ success: false, error: 'Missing data' });
        }
        
        if (bots.has(username)) {
            return res.status(400).json({ success: false, error: 'Already running' });
        }
        
        const result = await createBot(username, host, port, token);
        res.json({ success: true, ...result });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const bot = bots.get(username);
    
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    bot.client.end();
    bots.delete(username);
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const bot = bots.get(username);
    
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    bot.client.write('chat', { message });
    res.json({ success: true });
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    const bot = bots.get(username);
    
    if (!bot) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    setTimeout(() => {
        const random = generateRandom();
        const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
        
        try {
            bot.client.write('chat', { message });
            console.log(`[${username}] 🎯 Force → ${target}`);
        } catch {}
    }, 1000);
    
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcName,
        connected: bot.client.socket?.writable || false,
        queueLength: bot.queue.length,
        cooldownCount: bot.cooldown.size
    }));
    
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

process.on('SIGTERM', () => {
    bots.forEach((bot) => bot.client.end());
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('🚀 Bot Manager v6.0');
    console.log('🔧 NO AUTH MODE (Direct session)');
    console.log(`✅ Port ${PORT}`);
    console.log('=================================');
});
