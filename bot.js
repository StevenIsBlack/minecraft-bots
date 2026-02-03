const mc = require('minecraft-protocol');
const express = require('express');
const { Authflow, Titles } = require('prismarine-auth');
const app = express();

app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set();
const MAX_QUEUE_SIZE = 100;
const MESSAGE_INTERVAL = 2500; // 2.5 seconds

function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 2) throw new Error('Invalid format - use email:password');
    return {
        email: parts[0],
        password: parts[1]
    };
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

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    let text = component.text || '';
    if (component.extra) component.extra.forEach(e => text += extractText(e));
    return text;
}

async function authenticateAccount(email, password) {
    try {
        console.log(`🔑 Authenticating ${email}...`);
        
        const authflow = new Authflow(email, './auth-cache', {
            authTitle: Titles.MinecraftJava,
            flow: 'live',
            password: password
        });
        
        const auth = await authflow.getMinecraftJavaToken({ fetchProfile: true });
        
        if (!auth || !auth.profile) {
            throw new Error('Authentication failed - no profile');
        }
        
        console.log(`✅ Authenticated as ${auth.profile.name}`);
        
        return {
            username: auth.profile.name,
            uuid: auth.profile.id,
            accessToken: auth.token,
            auth: authflow
        };
    } catch (error) {
        console.error(`❌ Auth error: ${error.message}`);
        throw new Error(`Authentication failed: ${error.message}`);
    }
}

async function createBot(botId, host, port, credentials, isReconnect = false) {
    try {
        if (bannedAccounts.has(botId)) {
            return { success: false, error: 'Banned' };
        }

        console.log(`[${botId}] ${isReconnect ? '🔄' : '🚀'} Starting...`);
        
        const creds = parseCredentials(credentials);
        
        // Authenticate automatically
        const authData = await authenticateAccount(creds.email, creds.password);

        console.log(`[${botId}] 👤 ${authData.username}`);
        console.log(`[${botId}] 🆔 ${authData.uuid}`);

        // Create client with proper auth
        const client = mc.createClient({
            host: host,
            port: port,
            username: authData.username,
            auth: 'microsoft',
            session: {
                accessToken: authData.accessToken,
                selectedProfile: {
                    id: authData.uuid,
                    name: authData.username
                }
            },
            version: false, // Auto-detect
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
            mcUsername: authData.username,
            queue,
            cooldown,
            credentials,
            host,
            port,
            isOnline: false,
            forceTarget: null,
            authData
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
        });
        
        client.on('spawn_position', () => {
            console.log(`[${botId}] 🎮 SPAWNED - Starting auto-messaging!`);
            // Start messaging automatically when spawned
            startNormalMessaging();
        });
        
        // Listen to chat to collect player names
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const msg = extractText(text);
                
                if (!msg) return;
                
                // Log all chat for debugging
                console.log(`[${botId}] 💬 ${msg}`);
                
                // Don't collect if in force mode
                if (forceTarget) return;
                if (!isCollecting) return;
                
                const name = parseName(msg, authData.username);
                
                if (name && 
                    !cooldown.has(name) && 
                    !queue.includes(name) &&
                    queue.length < MAX_QUEUE_SIZE) {
                    
                    queue.push(name);
                    console.log(`[${botId}] 🔥 Added ${name} to queue (${queue.length}/${MAX_QUEUE_SIZE})`);
                    
                    if (queue.length === MAX_QUEUE_SIZE) {
                        isCollecting = false;
                        queueCycle++;
                        console.log(`[${botId}] 📊 Cycle #${queueCycle} FULL - Will send when ready`);
                    }
                }
            } catch (err) {
                // Ignore parse errors
            }
        });
        
        // Normal queue messaging function
        function startNormalMessaging() {
            if (normalSender) clearInterval(normalSender);
            
            normalSender = setInterval(() => {
                if (!isOnline || !client.socket?.writable) return;
                if (forceTarget) return; // Don't send if in force mode
                
                if (queue.length > 0) {
                    const now = Date.now();
                    if (now - lastSend >= MESSAGE_INTERVAL) {
                        const target = queue.shift();
                        
                        try {
                            client.write('chat', { message: `/msg ${target} donut.lat` });
                            console.log(`[${botId}] ✅ → ${target} | Queue: ${queue.length} left`);
                            
                            lastSend = now;
                            cooldown.add(target);
                            setTimeout(() => cooldown.delete(target), 10000); // 10s cooldown
                            
                            if (queue.length === 0) {
                                isCollecting = true;
                                console.log(`[${botId}] 🔄 Cycle #${queueCycle} complete - collecting names again`);
                            }
                        } catch (err) {
                            console.error(`[${botId}] ❌ Send error: ${err.message}`);
                        }
                    }
                }
            }, 100); // Check every 100ms
        }
        
        // Force messaging function
        botData.startForce = (target) => {
            // Stop normal messaging
            if (normalSender) {
                clearInterval(normalSender);
                normalSender = null;
            }
            
            // Clear queue and stop collecting
            queue.length = 0;
            isCollecting = false;
            forceTarget = target;
            botData.forceTarget = target;
            
            console.log(`[${botId}] 🎯 FORCE MODE → ${target} (queue stopped)`);
            
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
                        console.error(`[${botId}] ❌ Force send error: ${err.message}`);
                    }
                }
            }, 100);
        };
        
        // Stop force and resume normal messaging
        botData.stopForce = () => {
            if (forceSender) {
                clearInterval(forceSender);
                forceSender = null;
            }
            
            forceTarget = null;
            botData.forceTarget = null;
            isCollecting = true;
            queue.length = 0; // Clear old queue
            
            console.log(`[${botId}] ✅ Force stopped - resuming normal queue`);
            
            // Restart normal messaging
            startNormalMessaging();
        };
        
        client.on('kick_disconnect', (packet) => {
            if (normalSender) clearInterval(normalSender);
            if (forceSender) clearInterval(forceSender);
            
            try {
                const reason = JSON.parse(packet.reason);
                const reasonText = extractText(reason);
                
                console.error(`[${botId}] 🚫 ============ KICKED ============`);
                console.error(`[${botId}] 📋 Reason: ${reasonText}`);
                console.error(`[${botId}] ================================`);
                
                if (reasonText.toLowerCase().includes('mute') || 
                    reasonText.toLowerCase().includes('silenced') ||
                    reasonText.toLowerCase().includes('chat') ||
                    reasonText.toLowerCase().includes('restricted')) {
                    console.log(`[${botId}] 🔇 Account MUTED`);
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
                
                if (reasonText.toLowerCase().includes('ban')) {
                    console.log(`[${botId}] ⛔ Account BANNED`);
                    bannedAccounts.add(botId);
                    bots.delete(botId);
                    return;
                }
                
            } catch (err) {
                console.error(`[${botId}] 🚫 KICKED (couldn't parse reason): ${err.message}`);
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
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ Error: ${err.message}`);
        });
        
        bots.set(botId, botData);
        
        return { success: true, mcUsername: authData.username, uuid: authData.uuid };
        
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
            bot.startForce(target);
            count++;
        }
    });
    
    if (count === 0) return res.status(400).json({ success: false, error: 'No bots online' });
    
    console.log(`🎯 ${count} bot(s) now force messaging ${target}`);
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
    
    console.log(`✅ Stopped force on ${count} bot(s), resumed queue`);
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
    console.log(`🔑 Auto-Authentication Mode`);
    console.log(`📊 Queue: ${MAX_QUEUE_SIZE}/cycle`);
    console.log(`⏱️  Message interval: ${MESSAGE_INTERVAL}ms`);
    console.log(`💬 Message: "donut.lat"`);
});
