const mineflayer = require('mineflayer');
const { Authflow } = require('prismarine-auth');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set();
const CACHE_DIR = './auth_cache';

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 3) {
        throw new Error('Invalid format. Use: email:password:token');
    }
    return {
        email: parts[0],
        password: parts[1],
        token: parts.slice(2).join(':')
    };
}

function decodeJWT(token) {
    try {
        const parts = token.split('.');
        let payload = parts[1];
        while (payload.length % 4 !== 0) payload += '=';
        return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (e) {
        return null;
    }
}

// Custom Authflow that uses your token WITHOUT asking for login
class CachedAuthflow extends Authflow {
    constructor(username, cache, token, tokenData) {
        super(username, cache);
        this.token = token;
        this.tokenData = tokenData;
        this.mcProfile = {
            id: tokenData.pfd?.[0]?.id || tokenData.profiles?.mc,
            name: tokenData.pfd?.[0]?.name
        };
    }

    async getMinecraftJavaToken(options = {}) {
        // Return cached token instead of doing login flow
        return {
            token: this.token,
            expires_on: this.tokenData.exp ? new Date(this.tokenData.exp * 1000) : new Date(Date.now() + 86400000),
            profile: this.mcProfile
        };
    }

    async getXboxToken(relyingParty) {
        // Return fake Xbox token to satisfy auth flow
        return {
            userHash: this.tokenData.xuid || 'cached',
            XSTSToken: this.token,
            expiresOn: this.tokenData.exp ? new Date(this.tokenData.exp * 1000) : new Date(Date.now() + 86400000)
        };
    }

    async getMsaToken() {
        // Return the token we already have
        return {
            token: this.token,
            expires_on: this.tokenData.exp || (Date.now() / 1000) + 86400
        };
    }
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
        if (i === len) result += ' ';
        else result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

async function createBot(botId, host, port, credentials, isReconnect = false) {
    try {
        if (bannedAccounts.has(botId)) {
            console.log(`[${botId}] ⛔ Banned`);
            return { success: false, error: 'Banned' };
        }

        console.log(`[${botId}] ${isReconnect ? '🔄' : '🚀'} Starting...`);
        
        const creds = parseCredentials(credentials);
        const tokenData = decodeJWT(creds.token);

        if (!tokenData) {
            throw new Error('Invalid token');
        }

        const mcName = tokenData.pfd?.[0]?.name;
        const mcUuid = tokenData.pfd?.[0]?.id || tokenData.profiles?.mc;

        if (!mcName || !mcUuid) {
            throw new Error('Token missing Minecraft profile');
        }

        console.log(`[${botId}] 👤 ${mcName}`);

        // Use custom authflow that doesn't ask for login
        const authflow = new CachedAuthflow(creds.email, CACHE_DIR, creds.token, tokenData);

        console.log(`[${botId}] 🔌 Connecting...`);

        const client = mineflayer.createBot({
            host: host,
            port: port,
            username: mcName,
            auth: 'microsoft',
            authflow: authflow,
            version: false,
            hideErrors: false,
            skipValidation: true
        });

        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let reconnectAttempts = 0;
        
        const botData = {
            client,
            mcUsername: mcName,
            queue,
            cooldown,
            credentials,
            host,
            port,
            isOnline: false
        };
        
        client.on('login', () => {
            console.log(`[${botId}] ✅ LOGGED IN as ${client.username}!`);
            isOnline = true;
            botData.isOnline = true;
            reconnectAttempts = 0;
        });
        
        client.on('spawn', () => {
            console.log(`[${botId}] 🎮 SPAWNED!`);
        });
        
        // ONLY log messages from OTHER players (not all chat)
        client.on('messagestr', (message) => {
            // Ignore our own messages, discord links, and system messages
            if (message.includes('[AutoMsg]') || 
                message.includes('discord.gg') ||
                message.includes(mcName)) return;
            
            const name = parseName(message, mcName);
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
                // Only log when we queue someone
                console.log(`[${botId}] 📥 Queued: ${name} (Queue: ${queue.length})`);
            }
        });
        
        const sender = setInterval(() => {
            if (!isOnline || !client._client?.socket) return;
            
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                
                try {
                    const msg = `/msg ${target} discord.gg\\bills cheapest market ${generateRandom()}`;
                    client.chat(msg);
                    
                    // ONLY LOG SENT MESSAGES
                    console.log(`[${botId}] ✅ Sent to ${target} | Remaining: ${queue.length}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch {}
            }
        }, 100);
        
        client.on('kicked', (reason) => {
            clearInterval(sender);
            console.error(`[${botId}] 🚫 KICKED: ${reason}`);
            
            if (reason.toLowerCase().includes('ban')) {
                bannedAccounts.add(botId);
                bots.delete(botId);
                return;
            }
            
            botData.isOnline = false;
            
            if (reconnectAttempts < 3) {
                reconnectAttempts++;
                setTimeout(() => {
                    createBot(botId, host, port, credentials, true);
                }, 10000);
            } else {
                bots.delete(botId);
            }
        });
        
        client.on('end', () => {
            clearInterval(sender);
            console.log(`[${botId}] 🔌 Disconnected`);
            botData.isOnline = false;
        });
        
        client.on('error', (err) => {
            // Only log important errors
            if (!err.message.includes('keepalive')) {
                console.error(`[${botId}] ❌ ${err.message}`);
            }
        });
        
        bots.set(botId, botData);
        
        return { success: true, mcUsername: mcName, uuid: mcUuid };
        
    } catch (error) {
        console.error(`[${botId}] ❌ ${error.message}`);
        throw error;
    }
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        if (!username || !token) return res.status(400).json({ success: false, error: 'Missing data' });
        if (bots.has(username)) return res.status(400).json({ success: false, error: 'Already running' });
        
        const result = await createBot(username, host, port, token);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    try { bot.client.end(); } catch {}
    bots.delete(username);
    res.json({ success: true });
});

app.post('/stopall', (req, res) => {
    const count = bots.size;
    bots.forEach((bot) => { try { bot.client.end(); } catch {} });
    bots.clear();
    res.json({ success: true, stopped: count });
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    
    setTimeout(() => {
        try {
            bot.client.chat(`/msg ${target} discord.gg\\bills cheapest market ${generateRandom()}`);
            console.log(`[${username}] 🎯 Force sent to ${target}`);
        } catch {}
    }, 1000);
    
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcUsername,
        connected: bot.isOnline,
        queue: bot.queue.length,
        cooldowns: bot.cooldown.size
    }));
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ Running on ${PORT}`);
    console.log(`🎫 No-Auth Mode: ENABLED`);
    console.log(`📊 Clean Logs: ENABLED`);
});
