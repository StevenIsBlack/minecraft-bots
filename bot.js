const mc = require('minecraft-protocol');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set();
const MAX_QUEUE_SIZE = 100;
const MESSAGE_INTERVAL = 2500; // 2.5 seconds

function parseCredentials(input) {
    // Support both formats: email:password:token OR just token
    const parts = input.split(':');
    if (parts.length >= 3) {
        // Format: email:password:token
        return {
            token: parts.slice(2).join(':'),
            email: parts[0]
        };
    } else {
        // Format: just token
        return {
            token: input,
            email: null
        };
    }
}

function decodeJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length < 2) return null;
        
        let payload = parts[1];
        // Add padding if needed
        while (payload.length % 4 !== 0) payload += '=';
        
        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (err) {
        console.error('JWT decode error:', err.message);
        return null;
    }
}

function parseName(text, myName) {
    if (!text || !text.includes(':')) return null;
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

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    let text = component.text || '';
    if (component.extra) component.extra.forEach(e => text += extractText(e));
    return text;
}

async function createBot(botId, host, port, credentials) {
    try {
        if (bannedAccounts.has(botId)) {
            return { success: false, error: 'Account is banned/muted' };
        }

        console.log(`[${botId}] 🚀 Starting...`);
        
        const creds = parseCredentials(credentials);
        const tokenData = decodeJWT(creds.token);

        if (!tokenData) {
            throw new Error('Invalid token - could not decode');
        }

        // Try different token structures
        const mcName = tokenData.pfd?.[0]?.name || 
                      tokenData.selectedProfile?.name || 
                      tokenData.name;
        
        const mcUuid = tokenData.pfd?.[0]?.id || 
                      tokenData.selectedProfile?.id || 
                      tokenData.uuid ||
                      tokenData.id;

        if (!mcName || !mcUuid) {
            console.error('Token data:', JSON.stringify(tokenData, null, 2));
            throw new Error('No Minecraft profile found in token');
        }

        console.log(`[${botId}] 👤 Username: ${mcName}`);
        console.log(`[${botId}] 🆔 UUID: ${mcUuid}`);

        // Create client with offline mode (no auth verification needed)
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            auth: 'offline', // Use offline mode to avoid verification
            version: false, // Auto-detect version
            hideErrors: false
        });

        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let queueCycle = 0;
        let isCollecting = true;
        let forceTarget = null;
        let forceSender = null;
        let normalSender = null;
        
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
            console.log(`[${botId}] 🔌 Connected to ${host}:${port}`);
        });

        client.on('success', () => {
            console.log(`[${botId}] ✅ Connection success!`);
        });
        
        client.on('login', (packet) => {
            console.log(`[${botId}] ✅ LOGGED IN as ${mcName}!`);
            isOnline = true;
            botData.isOnline = true;
        });
        
        client.on('spawn_position', () => {
            console.log(`[${botId}] 🎮 SPAWNED - Auto-messaging started!`);
            startNormalMessaging();
        });
        
        // Listen to chat for player names
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const msg = extractText(text);
                
                if (!msg) return;
                
                // Log chat for debugging
                console.log(`[${botId}] 💬 ${msg}`);
                
                // Don't collect if in force mode
                if (forceTarget) return;
                if (!isCollecting) return;
                
                const name = parseName(msg, mcName);
                
                if (name && 
                    !cooldown.has(name) && 
                    !queue.includes(name) &&
                    queue.length < MAX_QUEUE_SIZE) {
                    
                    queue.push(name);
                    console.log(`[${botId}] 🔥 Queued: ${name} (${queue.length}/${MAX_QUEUE_SIZE})`);
                    
                    if (queue.length === MAX_QUEUE_SIZE) {
                        isCollecting = false;
                        queueCycle++;
                        console.log(`[${botId}] 📊 Cycle #${queueCycle} FULL`);
                    }
                }
            } catch (err) {
                // Ignore parse errors
            }
        });
        
        // Normal messaging function
        function startNormalMessaging() {
            if (normalSender) clearInterval(normalSender);
            
            normalSender = setInterval(() => {
                if (!isOnline || !client.socket?.writable) return;
                if (forceTarget) return; // Don't send if forcing
                
                if (queue.length > 0) {
                    const now = Date.now();
                    if (now - lastSend >= MESSAGE_INTERVAL) {
                        const target = queue.shift();
                        
                        try {
                            client.write('chat', { message: `/msg ${target} donut.lat` });
                            console.log(`[${botId}] ✅ Sent to ${target} | Queue: ${queue.length}`);
                            
                            lastSend = now;
                            cooldown.add(target);
                            setTimeout(() => cooldown.delete(target), 10000);
                            
                            if (queue.length === 0) {
                                isCollecting = true;
                                console.log(`[${botId}] 🔄 Queue empty - collecting again`);
                            }
                        } catch (err) {
                            console.error(`[${botId}] ❌ Send failed: ${err.message}`);
                        }
                    }
                }
            }, 100);
        }
        
        // Force messaging
        botData.startForce = (target) => {
            // Stop normal messaging
            if (normalSender) {
                clearInterval(normalSender);
                normalSender = null;
            }
            
            // Clear queue
            queue.length = 0;
            isCollecting = false;
            forceTarget = target;
            botData.forceTarget = target;
            
            console.log(`[${botId}] 🎯 FORCE MODE → ${target}`);
            
            if (forceSender) clearInterval(forceSender);
            
            forceSender = setInterval(() => {
                if (!isOnline || !client.socket?.writable || !forceTarget) {
                    if (forceSender) clearInterval(forceSender);
                    return;
                }
                
                const now = Date.now();
                if (now - lastSend >= MESSAGE_INTERVAL) {
                    try {
                        client.write('chat', { message: `/msg ${forceTarget} donut.lat` });
                        console.log(`[${botId}] 🎯 FORCE → ${forceTarget}`);
                        lastSend = now;
                    } catch (err) {
                        console.error(`[${botId}] ❌ Force failed: ${err.message}`);
                    }
                }
            }, 100);
        };
        
        // Stop force mode
        botData.stopForce = () => {
            if (forceSender) {
                clearInterval(forceSender);
                forceSender = null;
            }
            
            forceTarget = null;
            botData.forceTarget = null;
            isCollecting = true;
            queue.length = 0;
            
            console.log(`[${botId}] ✅ Force stopped - resuming queue`);
            
            startNormalMessaging();
        };
        
        client.on('kick_disconnect', (packet) => {
            if (normalSender) clearInterval(normalSender);
            if (forceSender) clearInterval(forceSender);
            
            try {
                const reason = JSON.parse(packet.reason);
                const reasonText = extractText(reason);
                
                console.error(`[${botId}] 🚫 KICKED: ${reasonText}`);
                
                if (reasonText.toLowerCase().includes('mute') || 
                    reasonText.toLowerCase().includes('silenced') ||
                    reasonText.toLowerCase().includes('chat')) {
                    console.log(`[${botId}] 🔇 MUTED - Adding to ban list`);
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
                
                if (reasonText.toLowerCase().includes('ban')) {
                    console.log(`[${botId}] ⛔ BANNED`);
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
                
            } catch (err) {
                console.error(`[${botId}] 🚫 KICKED (parse error): ${err.message}`);
            }
            
            botData.isOnline = false;
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            if (normalSender) clearInterval(normalSender);
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
            if (normalSender) clearInterval(normalSender);
            if (forceSender) clearInterval(forceSender);
            botData.isOnline = false;
            console.log(`[${botId}] 🔚 Connection ended`);
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ Error: ${err.message}`);
        });
        
        bots.set(botId, botData);
        
        return { success: true, mcUsername: mcName, uuid: mcUuid };
        
    } catch (error) {
        console.error(`[${botId}] ❌ Failed: ${error.message}`);
        throw error;
    }
}

// API Endpoints
app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        if (!username || !token) {
            return res.status(400).json({ success: false, error: 'Missing username or token' });
        }
        
        if (bots.has(username)) {
            return res.status(400).json({ success: false, error: 'Bot already running' });
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
    if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });
    
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
    if (!target) return res.status(400).json({ success: false, error: 'Missing target player' });
    
    let count = 0;
    bots.forEach((bot) => {
        if (bot.isOnline && bot.startForce) {
            bot.startForce(target);
            count++;
        }
    });
    
    if (count === 0) {
        return res.status(400).json({ success: false, error: 'No bots online' });
    }
    
    console.log(`🎯 ${count} bot(s) now forcing ${target}`);
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
    
    console.log(`✅ Stopped force on ${count} bot(s)`);
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
    console.log(`✅ Bot API running on port ${PORT}`);
    console.log(`🎮 Offline Mode (Token-based)`);
    console.log(`📊 Queue size: ${MAX_QUEUE_SIZE}`);
    console.log(`⏱️  Interval: ${MESSAGE_INTERVAL}ms (2.5s)`);
    console.log(`💬 Message: "donut.lat"`);
});
