const mc = require('minecraft-protocol');
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set();

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
    } catch {
        return null;
    }
}

// CRITICAL: Convert Xbox token to Minecraft token WITHOUT Microsoft login
async function getMinecraftToken(xboxToken) {
    try {
        console.log('🔄 Converting Xbox token to Minecraft...');
        
        // Step 1: Get XSTS token
        const xstsResponse = await axios.post(
            'https://xsts.auth.xboxlive.com/xsts/authorize',
            {
                Properties: {
                    SandboxId: 'RETAIL',
                    UserTokens: [xboxToken]
                },
                RelyingParty: 'rp://api.minecraftservices.com/',
                TokenType: 'JWT'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'x-xbl-contract-version': '1'
                },
                validateStatus: () => true
            }
        );

        if (xstsResponse.status !== 200) {
            console.log('❌ XSTS failed:', xstsResponse.data);
            return null;
        }

        const xstsToken = xstsResponse.data.Token;
        const userHash = xstsResponse.data.DisplayClaims.xui[0].uhs;

        console.log('✅ Got XSTS token');

        // Step 2: Get Minecraft access token
        const mcResponse = await axios.post(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            {
                identityToken: `XBL3.0 x=${userHash};${xstsToken}`
            },
            {
                headers: { 'Content-Type': 'application/json' },
                validateStatus: () => true
            }
        );

        if (mcResponse.status !== 200) {
            console.log('❌ MC auth failed:', mcResponse.data);
            return null;
        }

        console.log('✅ Got Minecraft token!');
        
        return {
            accessToken: mcResponse.data.access_token,
            userHash: userHash
        };

    } catch (error) {
        console.error('Token conversion error:', error.message);
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

        if (!mcName) {
            throw new Error('No Minecraft profile in token');
        }

        console.log(`[${botId}] 👤 ${mcName}`);
        console.log(`[${botId}] 🆔 ${mcUuid}`);

        // Try to convert Xbox token to Minecraft token
        const mcAuth = await getMinecraftToken(creds.token);

        let accessToken;
        if (mcAuth) {
            console.log(`[${botId}] ✅ Using converted Minecraft token`);
            accessToken = mcAuth.accessToken;
        } else {
            console.log(`[${botId}] ⚠️ Using Xbox token directly (might not work)`);
            accessToken = creds.token;
        }

        console.log(`[${botId}] 🔌 Connecting...`);

        // Use minecraft-protocol with session injection
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            accessToken: accessToken,
            clientToken: tokenData.xuid || tokenData.aid,
            session: {
                accessToken: accessToken,
                clientToken: tokenData.xuid || tokenData.aid,
                selectedProfile: {
                    id: mcUuid,
                    name: mcName
                }
            },
            auth: 'mojang', // Use Mojang auth mode (not Microsoft)
            skipValidation: true,
            version: false,
            hideErrors: false
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
        
        client.on('connect', () => {
            console.log(`[${botId}] 🔌 Connected to server`);
        });

        client.on('success', () => {
            console.log(`[${botId}] ✅ Authentication successful!`);
        });

        client.on('login', (packet) => {
            console.log(`[${botId}] ✅ LOGGED IN as ${mcName}!`);
            isOnline = true;
            botData.isOnline = true;
            reconnectAttempts = 0;
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
                    console.log(`[${botId}] 📥 ${name}`);
                }
            } catch {}
        });
        
        const sender = setInterval(() => {
            if (!isOnline || !client.socket?.writable) return;
            
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                
                try {
                    client.write('chat', {
                        message: `/msg ${target} discord.gg\\bills cheapest market ${generateRandom()}`
                    });
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
                console.error(`[${botId}] 🚫 KICKED: ${reason.text || JSON.stringify(reason)}`);
                
                if ((reason.text || '').toLowerCase().includes('ban')) {
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
            } catch {
                console.error(`[${botId}] 🚫 KICKED`);
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
        
        client.on('disconnect', (packet) => {
            clearInterval(sender);
            try {
                const reason = JSON.parse(packet.reason);
                console.log(`[${botId}] 🔌 Disconnect: ${reason.text || 'Unknown'}`);
            } catch {
                console.log(`[${botId}] 🔌 Disconnected`);
            }
            botData.isOnline = false;
        });

        client.on('end', () => {
            clearInterval(sender);
            console.log(`[${botId}] 🔌 Connection ended`);
            botData.isOnline = false;
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ ${err.message}`);
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
            bot.client.write('chat', {
                message: `/msg ${target} discord.gg\\bills cheapest market ${generateRandom()}`
            });
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
    console.log(`🎫 Direct Protocol Auth: ENABLED`);
});
