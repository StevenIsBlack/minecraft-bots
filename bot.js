const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const bots = new Map();
const CACHE_DIR = './.minecraft-cache';

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

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
        
        const tokenData = decodeJWT(accessToken);
        
        const mcProfile = tokenData.profiles?.mc;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcProfile || !mcName) {
            throw new Error('Token missing Minecraft Java profile');
        }
        
        console.log(`[${botId}] Java Profile Found:`);
        console.log(`[${botId}]   Username: ${mcName}`);
        console.log(`[${botId}]   UUID: ${mcProfile}`);
        
        const expiresAt = new Date(tokenData.exp * 1000);
        if (expiresAt < new Date()) {
            throw new Error(`Token expired at ${expiresAt.toISOString()}`);
        }
        console.log(`[${botId}]   Expires: ${expiresAt.toISOString()}`);
        
        // Create cache file for this account
        const cacheFile = path.join(CACHE_DIR, `${email.replace('@', '_at_')}.json`);
        
        // Write cached authentication data
        const authCache = {
            userCache: {
                [email]: {
                    properties: [],
                    id: mcProfile,
                    name: mcName,
                    type: 'msa'
                }
            },
            selectedUserKey: email,
            msa: {
                token: accessToken,
                refresh_token: '',
                obtainedOn: Date.now(),
                expiresOn: tokenData.exp * 1000
            },
            xbl: {
                userHash: tokenData.sub || '',
                XSTSToken: accessToken,
                expiresOn: tokenData.exp * 1000
            },
            mca: {
                token: accessToken,
                obtainedOn: Date.now(),
                expiresOn: tokenData.exp * 1000,
                profile: {
                    id: mcProfile,
                    name: mcName
                }
            }
        };
        
        fs.writeFileSync(cacheFile, JSON.stringify(authCache, null, 2));
        console.log(`[${botId}] Created auth cache at ${cacheFile}`);
        
        console.log(`[${botId}] Connecting to ${host}:${port}...`);
        
        // Create authflow with cached data
        const authflow = new Authflow(email, CACHE_DIR, {
            authTitle: Titles.MinecraftJava,
            deviceType: 'Win32',
            flow: 'live',
            password: undefined // Prevent password prompts
        });
        
        // Inject our cached token into authflow
        authflow.mca = {
            token: accessToken,
            obtainedOn: Date.now(),
            expiresOn: tokenData.exp * 1000,
            profile: {
                id: mcProfile,
                name: mcName
            }
        };
        
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: email,
            auth: 'microsoft',
            authflow: authflow,
            profilesFolder: CACHE_DIR,
            version: false,
            hideErrors: false,
            checkTimeoutInterval: 30000,
            viewDistance: 'tiny'
        });
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        
        bot.on('login', () => {
            console.log(`✅ [${botId}] Login successful!`);
            console.log(`✅ [${botId}] Username: ${bot.username}`);
            isOnline = true;
        });
        
        bot.on('spawn', () => {
            console.log(`🎮 [${botId}] Spawned!`);
            console.log(`🎮 [${botId}] Health: ${bot.health}, Food: ${bot.food}`);
        });
        
        bot.on('message', (message) => {
            try {
                const msg = message.toString();
                
                if (!msg || msg.includes('[AutoMsg]') || msg.includes('discord.gg')) {
                    return;
                }
                
                const name = parseName(msg, bot.username);
                
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${botId}] 📥 Queued: ${name}`);
                }
            } catch (e) {}
        });
        
        const sender = setInterval(() => {
            if (!isOnline || !bot.player) return;
            
            const now = Date.now();
            
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = generateRandom();
                const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
                
                try {
                    bot.chat(message);
                    console.log(`[${botId}] 📨 → ${target}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (e) {}
            }
        }, 100);
        
        bot.on('kicked', (reason) => {
            clearInterval(sender);
            console.error(`🚫 [${botId}] Kicked: ${reason}`);
            bots.delete(botId);
        });
        
        bot.on('end', () => {
            clearInterval(sender);
            isOnline = false;
            bots.delete(botId);
        });
        
        bot.on('error', (err) => {
            console.error(`❌ [${botId}] ${err.message}`);
        });
        
        bots.set(botId, { 
            bot,
            mcName, 
            uuid: mcProfile,
            queue, 
            cooldown,
            startTime: Date.now()
        });
        
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
    const botData = bots.get(username);
    
    if (!botData) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    botData.bot.quit();
    bots.delete(username);
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const botData = bots.get(username);
    
    if (!botData) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    botData.bot.chat(message);
    res.json({ success: true });
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    const botData = bots.get(username);
    
    if (!botData) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    setTimeout(() => {
        const random = generateRandom();
        const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
        botData.bot.chat(message);
    }, 1000);
    
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, botData]) => ({
        username,
        mcUsername: botData.mcName,
        connected: !!botData.bot.player,
        health: botData.bot.health || 0,
        queueLength: botData.queue.length
    }));
    
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

process.on('SIGTERM', () => {
    bots.forEach((botData) => botData.bot.quit());
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('🚀 Bot Manager v5.0 - CACHED AUTH');
    console.log(`✅ Port ${PORT}`);
    console.log('=================================');
});
