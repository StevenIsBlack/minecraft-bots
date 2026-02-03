const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set();
const CACHE_DIR = './auth_cache';
const MAX_QUEUE_SIZE = 100;

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 3) throw new Error('Invalid format');
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
    } catch {
        return null;
    }
}

// Fixed authflow - creates cache file to avoid login prompt
class CachedAuthflow extends Authflow {
    constructor(username, cacheDir, token, tokenData) {
        super(username, cacheDir, { authTitle: Titles.MinecraftJava, flow: 'live' });
        
        this.token = token;
        this.tokenData = tokenData;
        this.profile = {
            id: tokenData.pfd?.[0]?.id || tokenData.profiles?.mc,
            name: tokenData.pfd?.[0]?.name
        };
        
        // Create cache file immediately
        const cacheFile = path.join(cacheDir, `${username}.json`);
        const cache = {
            mca: {
                token: token,
                obtainedOn: Date.now(),
                expiresOn: (tokenData.exp || Math.floor(Date.now() / 1000) + 86400) * 1000,
                profile: this.profile
            }
        };
        
        try {
            fs.writeFileSync(cacheFile, JSON.stringify(cache));
            console.log(`Created cache for ${username}`);
        } catch (e) {
            console.log(`Cache creation failed: ${e.message}`);
        }
    }

    async getMinecraftJavaToken() {
        return {
            token: this.token,
            expiresOn: (this.tokenData.exp || Math.floor(Date.now() / 1000) + 86400) * 1000,
            profile: this.profile
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
            return { success: false, error: 'Banned' };
        }

        console.log(`[${botId}] ${isReconnect ? '🔄' : '🚀'} Starting...`);
        
        const creds = parseCredentials(credentials);
        const tokenData = decodeJWT(creds.token);

        if (!tokenData) throw new Error('Invalid token');

        const mcName = tokenData.pfd?.[0]?.name;
        const mcUuid = tokenData.pfd?.[0]?.id || tokenData.profiles?.mc;

        if (!mcName) throw new Error('No Minecraft profile');

        console.log(`[${botId}] 👤 ${mcName}`);

        const authflow = new CachedAuthflow(creds.email, CACHE_DIR, creds.token, tokenData);

        const client = mineflayer.createBot({
            host: host,
            port: port,
            username: mcName,
            auth: 'microsoft',
            authflow: authflow,
            version: false,
            hideErrors: false,
            skipValidation: true,
            profilesFolder: CACHE_DIR
        });

        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let reconnectAttempts = 0;
        let queueCycle = 0;
        let isCollecting = true;
        let forceTarget = null; // Force mode target
        let forceSender = null; // Force interval
        
        const botData = {
            client,
            mcUsername: mcName,
            queue,
            cooldown,
            credentials,
            host,
            port,
            isOnline: false,
            forceTarget: null
        };
        
        client.on('login', () => {
            console.log(`[${botId}] ✅ LOGGED IN as ${mcName}!`);
            isOnline = true;
            botData.isOnline = true;
            reconnectAttempts = 0;
        });
        
        client.on('spawn', () => {
            console.log(`[${botId}] 🎮 SPAWNED - Ready to message!`);
        });
        
        client.on('messagestr', (message) => {
            if (message.includes('[AutoMsg]') || 
                message.includes('discord.gg') ||
                message.includes(mcName)) return;
            
            // Don't collect during force mode
            if (forceTarget) return;
            if (!isCollecting) return;
            
            const name = parseName(message, mcName);
            
            if (name && 
                !cooldown.has(name) && 
                !queue.includes(name) &&
                queue.length < MAX_QUEUE_SIZE) {
                
                queue.push(name);
                console.log(`[${botId}] 📥 ${name} (${queue.length}/${MAX_QUEUE_SIZE})`);
                
                if (queue.length === MAX_QUEUE_SIZE) {
                    isCollecting = false;
                    queueCycle++;
                    console.log(`[${botId}] 📊 Cycle #${queueCycle} FULL - Sending...`);
                }
            }
        });
        
        // Normal queue sender
        const sender = setInterval(() => {
            if (!isOnline || !client._client?.socket) return;
            if (forceTarget) return; // Skip if in force mode
            
            if (queue.length > 0 && !isCollecting) {
                const now = Date.now();
                if (now - lastSend >= 2000) {
                    const target = queue.shift();
                    
                    try {
                        client.chat(`/msg ${target} discord.gg\\bils ${generateRandom()}`);
                        console.log(`[${botId}] ✅ → ${target} | Left: ${queue.length}`);
                        
                        lastSend = now;
                        cooldown.add(target);
                        setTimeout(() => cooldown.delete(target), 5000);
                        
                        if (queue.length === 0) {
                            isCollecting = true;
                            console.log(`[${botId}] 🔄 Cycle #${queueCycle} done - Collecting...`);
                        }
                    } catch {}
                }
            }
        }, 100);
        
        // Force message function
        botData.startForce = (target) => {
            forceTarget = target;
            isCollecting = false; // Stop collecting
            console.log(`[${botId}] 🎯 FORCE MODE → ${target}`);
            
            // Clear force interval if exists
            if (forceSender) clearInterval(forceSender);
            
            // Send every 2 seconds
            forceSender = setInterval(() => {
                if (!isOnline || !client._client?.socket || !forceTarget) {
                    if (forceSender) clearInterval(forceSender);
                    return;
                }
                
                try {
                    client.chat(`/msg ${forceTarget} discord.gg\\bils ${generateRandom()}`);
                    console.log(`[${botId}] 🎯 FORCE → ${forceTarget}`);
                } catch {}
            }, 2000);
        };
        
        botData.stopForce = () => {
            if (forceSender) {
                clearInterval(forceSender);
                forceSender = null;
            }
            forceTarget = null;
            botData.forceTarget = null;
            isCollecting = true; // Resume collecting
            queue.length = 0; // Clear old queue
            console.log(`[${botId}] ✅ Force stopped - Queue resumed`);
        };
        
        client.on('kicked', (reason) => {
            clearInterval(sender);
            if (forceSender) clearInterval(forceSender);
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
            if (forceSender) clearInterval(forceSender);
            console.log(`[${botId}] 🔌 Disconnected`);
            botData.isOnline = false;
        });
        
        client.on('error', (err) => {
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

// Force ALL bots to message a player
app.post('/forcemsg', (req, res) => {
    const { target } = req.body;
    if (!target) return res.status(400).json({ success: false, error: 'Missing target' });
    
    let count = 0;
    bots.forEach((bot) => {
        if (bot.isOnline && bot.startForce) {
            bot.forceTarget = target;
            bot.startForce(target);
            count++;
        }
    });
    
    if (count === 0) {
        return res.status(400).json({ success: false, error: 'No bots online' });
    }
    
    console.log(`🎯 ${count} bots now force messaging ${target}`);
    res.json({ success: true, sent: count, target: target });
});

// Stop force mode on all bots
app.post('/stopforce', (req, res) => {
    let count = 0;
    bots.forEach((bot) => {
        if (bot.forceTarget && bot.stopForce) {
            bot.stopForce();
            count++;
        }
    });
    
    console.log(`✅ Stopped force mode on ${count} bots`);
    res.json({ success: true, stopped: count });
});

app.get('/status', (req, res) => {
    const onlineCount = Array.from(bots.values()).filter(b => b.isOnline).length;
    res.json({ 
        success: true, 
        total: bots.size,
        online: onlineCount
    });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ Running on ${PORT}`);
    console.log(`🎫 Cached Auth: ENABLED`);
    console.log(`📊 Queue: 100/cycle`);
    console.log(`🎯 Force Mode: READY`);
});
