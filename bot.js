const mc = require('minecraft-protocol');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set();
const MAX_QUEUE_SIZE = 100;

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

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    let text = component.text || '';
    if (component.extra) component.extra.forEach(e => text += extractText(e));
    return text;
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

        if (!mcName || !mcUuid) throw new Error('No Minecraft profile');

        console.log(`[${botId}] 👤 ${mcName}`);
        console.log(`[${botId}] 🆔 ${mcUuid}`);

        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            accessToken: creds.token,
            clientToken: tokenData.xuid || mcUuid,
            session: {
                accessToken: creds.token,
                clientToken: tokenData.xuid || mcUuid,
                selectedProfile: {
                    id: mcUuid,
                    name: mcName
                }
            },
            skipValidation: true,
            version: false,
            hideErrors: false
        });

        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let reconnectAttempts = 0;
        let queueCycle = 0;
        let isCollecting = true;
        let forceTarget = null;
        let forceSender = null;
        
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
        
        client.on('connect', () => {
            console.log(`[${botId}] 🔌 Connected to server`);
        });

        client.on('success', () => {
            console.log(`[${botId}] ✅ Auth success!`);
        });
        
        client.on('login', (packet) => {
            console.log(`[${botId}] ✅ LOGGED IN!`);
            isOnline = true;
            botData.isOnline = true;
            reconnectAttempts = 0;
        });
        
        client.on('spawn_position', () => {
            console.log(`[${botId}] 🎮 SPAWNED - Ready to message!`);
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const msg = extractText(text);
                
                if (!msg || msg.includes('[AutoMsg]') || msg.includes('discord.gg') || msg.includes(mcName)) return;
                
                if (forceTarget) return;
                if (!isCollecting) return;
                
                const name = parseName(msg, mcName);
                
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
            } catch {}
        });
        
        const sender = setInterval(() => {
            if (!isOnline || !client.socket?.writable) return;
            if (forceTarget) return;
            
            if (queue.length > 0 && !isCollecting) {
                const now = Date.now();
                if (now - lastSend >= 2000) {
                    const target = queue.shift();
                    
                    try {
                        client.write('chat', { message: `/msg ${target} discord.gg\\bils ${generateRandom()}` });
                        console.log(`[${botId}] ✅ → ${target} | Left: ${queue.length}`);
                        
                        lastSend = now;
                        cooldown.add(target);
                        setTimeout(() => cooldown.delete(target), 5000);
                        
                        if (queue.length === 0) {
                            isCollecting = true;
                            console.log(`[${botId}] 🔄 Cycle #${queueCycle} done`);
                        }
                    } catch {}
                }
            }
        }, 100);
        
        botData.startForce = (target) => {
            forceTarget = target;
            isCollecting = false;
            console.log(`[${botId}] 🎯 FORCE → ${target}`);
            
            if (forceSender) clearInterval(forceSender);
            
            forceSender = setInterval(() => {
                if (!isOnline || !client.socket?.writable || !forceTarget) {
                    if (forceSender) clearInterval(forceSender);
                    return;
                }
                
                try {
                    client.write('chat', { message: `/msg ${forceTarget} discord.gg\\bils ${generateRandom()}` });
                    console.log(`[${botId}] 🎯 → ${forceTarget}`);
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
            isCollecting = true;
            queue.length = 0;
            console.log(`[${botId}] ✅ Force stopped`);
        };
        
        // DETAILED KICK LOGGING
        client.on('kick_disconnect', (packet) => {
            clearInterval(sender);
            if (forceSender) clearInterval(forceSender);
            
            try {
                const reason = JSON.parse(packet.reason);
                const reasonText = extractText(reason);
                
                console.error(`[${botId}] 🚫 ============ KICKED ============`);
                console.error(`[${botId}] 📋 Reason: ${reasonText}`);
                console.error(`[${botId}] 📋 Raw: ${JSON.stringify(reason)}`);
                console.error(`[${botId}] ================================`);
                
                // Check if it's muted
                if (reasonText.toLowerCase().includes('mute') || 
                    reasonText.toLowerCase().includes('silenced') ||
                    reasonText.toLowerCase().includes('chat') ||
                    reasonText.toLowerCase().includes('restricted')) {
                    console.log(`[${botId}] 🔇 Account is MUTED - Cannot join`);
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
                
                // Check if banned
                if (reasonText.toLowerCase().includes('ban')) {
                    console.log(`[${botId}] ⛔ Account BANNED`);
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
                
            } catch {
                console.error(`[${botId}] 🚫 KICKED (couldn't parse reason)`);
            }
            
            botData.isOnline = false;
            
            // Don't reconnect - just remove
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            clearInterval(sender);
            if (forceSender) clearInterval(forceSender);
            
            try {
                const reason = JSON.parse(packet.reason);
                const reasonText = extractText(reason);
                console.log(`[${botId}] 🔌 Disconnected: ${reasonText}`);
            } catch {
                console.log(`[${botId}] 🔌 Disconnected`);
            }
            
            botData.isOnline = false;
        });

        client.on('end', () => {
            clearInterval(sender);
            if (forceSender) clearInterval(forceSender);
            botData.isOnline = false;
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ Error: ${err.message}`);
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
    
    if (count === 0) return res.status(400).json({ success: false, error: 'No bots online' });
    
    console.log(`🎯 ${count} bots force messaging ${target}`);
    res.json({ success: true, sent: count, target });
});

app.post('/stopforce', (req, res) => {
    let count = 0;
    bots.forEach((bot) => {
        if (bot.forceTarget && bot.stopForce) {
            bot.stopForce();
            count++;
        }
    });
    
    console.log(`✅ Stopped force on ${count} bots`);
    res.json({ success: true, stopped: count });
});

app.get('/status', (req, res) => {
    const onlineCount = Array.from(bots.values()).filter(b => b.isOnline).length;
    res.json({ success: true, total: bots.size, online: onlineCount });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ Running on ${PORT}`);
    console.log(`🎫 Direct Session Mode`);
    console.log(`📊 Queue: 100/cycle`);
});
