const mc = require('minecraft-protocol');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const bots = new Map();
const CACHE_DIR = './auth_cache';

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function parseToken(tokenString) {
    const parts = tokenString.split(':');
    if (parts.length < 3) throw new Error('Invalid format');
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
        let payload = parts[1];
        while (payload.length % 4 !== 0) payload += '=';
        return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (e) {
        throw new Error('JWT decode failed');
    }
}

// CRITICAL: Force JAVA edition authentication
async function xboxToMinecraftJava(xboxToken) {
    try {
        console.log('🔄 Converting to JAVA token...');
        
        // Step 1: Get XSTS token for JAVA (not Bedrock)
        const xstsRes = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
            Properties: {
                SandboxId: 'RETAIL',
                UserTokens: [xboxToken]
            },
            // CRITICAL: Use Java relying party, not Bedrock
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT'
        }, {
            headers: { 
                'Content-Type': 'application/json',
                'x-xbl-contract-version': '1'
            },
            validateStatus: () => true
        });
        
        if (xstsRes.status !== 200) {
            console.log('❌ XSTS failed:', xstsRes.data);
            return null;
        }
        
        const xstsToken = xstsRes.data.Token;
        const userHash = xstsRes.data.DisplayClaims.xui[0].uhs;
        
        console.log('✅ Got XSTS token');
        
        // Step 2: Get MINECRAFT JAVA token (not Bedrock)
        const mcRes = await axios.post(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
            { 
                headers: { 
                    'Content-Type': 'application/json',
                    'User-Agent': 'MinecraftLauncher/2.0'
                },
                validateStatus: () => true
            }
        );
        
        if (mcRes.status !== 200) {
            console.log('❌ MC Java auth failed:', mcRes.data);
            return null;
        }
        
        console.log('✅ Got JAVA token!');
        
        // Verify we got JAVA profile, not Bedrock
        const profileRes = await axios.get(
            'https://api.minecraftservices.com/minecraft/profile',
            {
                headers: { 
                    'Authorization': `Bearer ${mcRes.data.access_token}`
                },
                validateStatus: () => true
            }
        );
        
        if (profileRes.status !== 200) {
            console.log('❌ No Java profile found - this is a Bedrock-only account!');
            return null;
        }
        
        console.log('✅ Confirmed JAVA profile:', profileRes.data.name);
        
        return {
            accessToken: mcRes.data.access_token,
            profile: profileRes.data
        };
        
    } catch (err) {
        console.error('Token conversion error:', err.message);
        return null;
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
        console.log(`[${botId}] Starting...`);
        const { email, accessToken } = parseToken(sessionToken);
        
        const tokenData = decodeJWT(accessToken);
        
        console.log(`[${botId}] Token type check...`);
        
        // CRITICAL: Convert Bedrock token to Java token
        const javaAuth = await xboxToMinecraftJava(accessToken);
        
        if (!javaAuth) {
            throw new Error('Cannot convert to Java token - account may be Bedrock-only or token invalid');
        }
        
        const mcName = javaAuth.profile.name;
        const mcProfile = javaAuth.profile.id;
        
        console.log(`[${botId}] ✅ JAVA account confirmed: ${mcName}`);
        console.log(`[${botId}] UUID: ${mcProfile}`);
        
        const cacheFile = path.join(CACHE_DIR, `${email}.json`);
        fs.writeFileSync(cacheFile, JSON.stringify({
            accessToken: javaAuth.accessToken,
            clientToken: tokenData.xuid || tokenData.aid,
            selectedProfile: { id: mcProfile, name: mcName }
        }));
        
        console.log(`[${botId}] Connecting with JAVA authentication...`);
        
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            auth: 'microsoft',
            session: {
                accessToken: javaAuth.accessToken,
                clientToken: tokenData.xuid || tokenData.aid,
                selectedProfile: { id: mcProfile, name: mcName }
            },
            skipValidation: true,
            profilesFolder: CACHE_DIR,
            version: false, // Auto-detect Java version
            hideErrors: false
        });
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        
        client.on('login', () => {
            console.log(`[${botId}] ✅ LOGGED IN AS JAVA!`);
            isOnline = true;
        });
        
        client.on('spawn_position', () => {
            console.log(`[${botId}] 🎮 SPAWNED!`);
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const msg = extractText(text);
                
                if (!msg || msg.includes('[AutoMsg]') || msg.includes('discord.gg')) return;
                
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
                    console.log(`[${botId}] 📨 Sent to ${target}`);
                    
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
                console.error(`[${botId}] 🚫 KICKED: ${reason.text}`);
            } catch {
                console.error(`[${botId}] 🚫 KICKED`);
            }
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            clearInterval(sender);
            bots.delete(botId);
        });
        
        client.on('end', () => {
            clearInterval(sender);
            isOnline = false;
            bots.delete(botId);
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ ${err.message}`);
        });
        
        bots.set(botId, { client, mcName, queue, cooldown });
        
        return { success: true, mcUsername: mcName, uuid: mcProfile };
        
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
    bot.client.end();
    bots.delete(username);
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    bot.client.write('chat', { message });
    res.json({ success: true });
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    if (!username || !target) return res.status(400).json({ success: false, error: 'Missing data' });
    
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });
    
    setTimeout(() => {
        const random = generateRandom();
        const message = `/msg ${target} discord.gg\\bills cheapest market ${random}`;
        
        try {
            bot.client.write('chat', { message });
            console.log(`[${username}] 🎯 Force sent to ${target}`);
        } catch (err) {
            console.error(`[${username}] Send failed`);
        }
    }, 1000);
    
    res.json({ success: true, message: `Sending to ${target}` });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcName,
        connected: bot.client.socket?.writable || false,
        queue: bot.queue.length,
        cooldowns: bot.cooldown.size
    }));
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Running on ${PORT}`));
