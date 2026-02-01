const mineflayer = require('mineflayer');
const express = require('express');
const { SocksClient } = require('socks');
const app = express();

app.use(express.json());

const bots = new Map();
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

async function createBot(botId, host, port, alteningToken, proxyString = null) {
    try {
        console.log(`[${botId}] Starting with TheAltening token...`);
        
        let proxy = null;
        if (proxyString) {
            proxy = parseProxy(proxyString);
            console.log(`[${botId}] 🌐 Proxy: ${proxy.host}:${proxy.port}`);
        } else if (PROXIES.length > 0) {
            const randomProxy = getRandomProxy();
            proxy = parseProxy(randomProxy);
            console.log(`[${botId}] 🌐 Auto-proxy: ${proxy.host}:${proxy.port}`);
        } else {
            console.log(`[${botId}] ⚠️  No proxy`);
        }
        
        const clientOptions = {
            host: host,
            port: port,
            username: alteningToken, // TheAltening uses token as username
            auth: 'microsoft', // TheAltening requires Microsoft auth mode
            authServer: 'http://authserver.thealtening.com', // TheAltening auth server
            sessionServer: 'http://sessionserver.thealtening.com', // TheAltening session server
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
                    console.error(`[${botId}] Proxy failed: ${err.message}`);
                    client.emit('error', err);
                });
            };
        }
        
        console.log(`[${botId}] Connecting to ${host}:${port}...`);
        const client = mineflayer.createBot(clientOptions);
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        let isOnline = false;
        let mcUsername = alteningToken;
        
        client.on('login', () => {
            mcUsername = client.username || alteningToken;
            console.log(`[${botId}] ✅ LOGGED IN as ${mcUsername}!`);
            isOnline = true;
        });
        
        client.on('spawn', () => {
            console.log(`[${botId}] 🎮 SPAWNED!`);
        });
        
        client.on('messagestr', (message) => {
            console.log(`[${botId}] 💬 ${message}`);
            
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
                    console.error(`[${botId}] Send failed: ${err.message}`);
                }
            }
        }, 100);
        
        client.on('kicked', (reason) => {
            clearInterval(sender);
            console.error(`[${botId}] 🚫 KICKED: ${reason}`);
            bots.delete(botId);
        });
        
        client.on('end', () => {
            clearInterval(sender);
            console.log(`[${botId}] 🔌 Ended`);
            isOnline = false;
            bots.delete(botId);
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ ${err.message}`);
        });
        
        bots.set(botId, { 
            client, 
            mcUsername, 
            queue, 
            cooldown, 
            proxy: proxy ? `${proxy.host}:${proxy.port}` : 'None' 
        });
        
        return { 
            success: true, 
            mcUsername: mcUsername, 
            proxy: proxy ? `${proxy.host}:${proxy.port}` : 'Direct' 
        };
        
    } catch (error) {
        console.error(`[${botId}] ❌ ${error.message}`);
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
        connected: bot.client._client?.socket?.writable || false,
        queue: bot.queue.length,
        cooldowns: bot.cooldown.size,
        proxy: bot.proxy
    }));
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`✅ Running on ${PORT}`);
    console.log(`🌐 Proxies: ${PROXIES.length}`);
    console.log(`🔑 TheAltening Mode: ENABLED`);
});
