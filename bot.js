const mineflayer = require('mineflayer');
const express = require('express');
const { SocksClient } = require('socks');
const app = express();

app.use(express.json());

const bots = new Map();
const bannedAccounts = new Set(); // Track banned accounts
const PROXIES = (process.env.PROXY_LIST || '').split(',').filter(p => p.trim());

function getRandomProxy() {
    if (PROXIES.length === 0) return null;
    return PROXIES[Math.floor(Math.random() * PROXIES.length)].trim();
}

function parseProxy(proxyString) {
    try {
        const url = new URL(proxyString);
        return {
            type: 5,
            host: url.hostname,
            port: parseInt(url.port) || 1080,
            userId: url.username || undefined,
            password: url.password || undefined
        };
    } catch {
        const [host, port] = proxyString.split(':');
        return { type: 5, host, port: parseInt(port) || 1080 };
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

async function createBot(botId, host, port, alteningToken, proxyString = null, isReconnect = false) {
    try {
        if (bannedAccounts.has(botId)) {
            console.log(`[${botId}] ⛔ Account is banned, not reconnecting`);
            return { success: false, error: 'Account is banned' };
        }

        if (!isReconnect) {
            console.log(`[${botId}] 🚀 Starting with TheAltening token...`);
        } else {
            console.log(`[${botId}] 🔄 Reconnecting...`);
        }
        
        let proxy = null;
        if (proxyString) {
            proxy = parseProxy(proxyString);
            console.log(`[${botId}] 🌐 Proxy: ${proxy.host}:${proxy.port}`);
        } else if (PROXIES.length > 0) {
            const randomProxy = getRandomProxy();
            proxy = parseProxy(randomProxy);
            console.log(`[${botId}] 🌐 Auto-proxy: ${proxy.host}:${proxy.port}`);
        }
        
        const clientOptions = {
            host: host,
            port: port,
            username: alteningToken,
            auth: 'microsoft',
            authServer: 'http://authserver.thealtening.com',
            sessionServer: 'http://sessionserver.thealtening.com',
            version: false,
            hideErrors: false
        };
        
        if (proxy) {
            clientOptions.connect = (client) => {
                SocksClient.createConnection({
                    proxy: proxy,
                    command: 'connect',
                    destination: { host: host, port: port }
                }).then(info => {
                    client.setSocket(info.socket);
                    client.emit('connect');
                }).catch(err => {
                    console.error(`[${botId}] 🌐❌ Proxy failed: ${err.message}`);
                    client.emit('error', err);
                });
            };
        }
        
        console.log(`[${botId}] 🔌 Connecting to ${host}:${port}...`);
        const client = mineflayer.createBot(clientOptions);
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let mcUsername = alteningToken;
        let reconnectAttempts = 0;
        const MAX_RECONNECT_ATTEMPTS = 5;
        
        // Store bot data
        const botData = {
            client,
            mcUsername,
            queue,
            cooldown,
            proxy: proxy ? `${proxy.host}:${proxy.port}` : 'None',
            token: alteningToken,
            host,
            port,
            proxyString,
            isOnline: false
        };
        
        client.on('login', () => {
            mcUsername = client.username || alteningToken;
            botData.mcUsername = mcUsername;
            console.log(`[${botId}] ✅ LOGGED IN as ${mcUsername}!`);
            isOnline = true;
            botData.isOnline = true;
            reconnectAttempts = 0; // Reset on successful login
        });
        
        client.on('spawn', () => {
            console.log(`[${botId}] 🎮 SPAWNED!`);
        });
        
        client.on('messagestr', (message) => {
            if (message.includes('[AutoMsg]') || message.includes('discord.gg')) return;
            
            const name = parseName(message, mcUsername);
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
                console.log(`[${botId}] 📥 Queued: ${name} (Total: ${queue.length})`);
            }
        });
        
        const sender = setInterval(() => {
            if (!isOnline || !client._client || !client._client.socket) return;
            
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = generateRandom();
                
                try {
                    client.chat(`/msg ${target} discord.gg\\bills cheapest market ${random}`);
                    console.log(`[${botId}] 📨 Sent to ${target} (Queue: ${queue.length})`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (err) {
                    console.error(`[${botId}] ❌ Send failed: ${err.message}`);
                }
            }
        }, 100);
        
        client.on('kicked', (reason) => {
            clearInterval(sender);
            console.error(`[${botId}] 🚫 KICKED FROM SERVER!`);
            console.error(`[${botId}] 📋 Kick Reason: ${reason}`);
            
            // Check if banned
            const reasonLower = reason.toLowerCase();
            if (reasonLower.includes('ban') || 
                reasonLower.includes('banned') || 
                reasonLower.includes('blacklist') ||
                reasonLower.includes('permanent')) {
                
                console.error(`[${botId}] ⛔ DETECTED AS BANNED - Will not reconnect`);
                bannedAccounts.add(botId);
                bots.delete(botId);
                botData.isOnline = false;
                return;
            }
            
            // Auto-reconnect if not banned
            console.log(`[${botId}] 🔄 Not banned, attempting reconnect in 10 seconds...`);
            botData.isOnline = false;
            
            setTimeout(() => {
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    console.log(`[${botId}] 🔄 Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
                    createBot(botId, host, port, alteningToken, proxyString, true);
                } else {
                    console.error(`[${botId}] ⛔ Max reconnect attempts reached, giving up`);
                    bots.delete(botId);
                }
            }, 10000);
        });
        
        client.on('end', () => {
            clearInterval(sender);
            console.log(`[${botId}] 🔌 Connection ended`);
            isOnline = false;
            botData.isOnline = false;
            
            // Auto-reconnect on unexpected disconnect (if not banned)
            if (!bannedAccounts.has(botId)) {
                setTimeout(() => {
                    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        reconnectAttempts++;
                        console.log(`[${botId}] 🔄 Auto-reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        createBot(botId, host, port, alteningToken, proxyString, true);
                    }
                }, 10000);
            }
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ Error: ${err.message}`);
        });
        
        bots.set(botId, botData);
        
        return { 
            success: true, 
            mcUsername: mcUsername, 
            proxy: proxy ? `${proxy.host}:${proxy.port}` : 'Direct' 
        };
        
    } catch (error) {
        console.error(`[${botId}] ❌ Failed: ${error.message}`);
        throw error;
    }
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565, proxy } = req.body;
        if (!username || !token) return res.status(400).json({ success: false, error: 'Missing data' });
        if (bots.has(username)) return res.status(400).json({ success: false, error: 'Already running' });
        
        const result = await createBot(username, host, port, token, proxy);
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

app.post('/stopall', (req, res) => {
    const count = bots.size;
    bots.forEach((bot) => {
        try {
            bot.client.end();
        } catch (err) {
            console.error('Error stopping bot:', err.message);
        }
    });
    bots.clear();
    res.json({ success: true, stopped: count });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    bot.client.chat(message);
    res.json({ success: true });
});

app.post('/forcemsg', (req, res) => {
    const { username, target } = req.body;
    if (!username || !target) return res.status(400).json({ success: false, error: 'Missing data' });
    
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Bot not found' });
    
    setTimeout(() => {
        const message = `/msg ${target} discord.gg\\bills cheapest market ${generateRandom()}`;
        try {
            bot.client.chat(message);
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
        mcUsername: bot.mcUsername,
        connected: bot.isOnline,
        queue: bot.queue.length,
        cooldowns: bot.cooldown.size,
        proxy: bot.proxy
    }));
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size, banned: bannedAccounts.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ Running on ${PORT}`);
    console.log(`🌐 Proxies: ${PROXIES.length}`);
    console.log(`🔑 TheAltening Mode: ENABLED`);
    console.log(`🔄 Auto-Reconnect: ENABLED`);
});
