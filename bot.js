const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

function decodeJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        const profile = payload.pfd?.[0];
        if (!profile) throw new Error('No profile in token');
        
        return {
            username: profile.name,
            uuid: profile.id.replace(/-/g, ''),
            accessToken: token
        };
    } catch (err) {
        console.error('Token decode failed:', err.message);
        return null;
    }
}

function startBot(account) {
    const info = decodeJWT(account.token);
    if (!info) {
        console.error('Invalid token for account');
        return;
    }
    
    console.log(`Starting bot: ${info.username}`);
    account.username = info.username;
    
    try {
        const bot = mineflayer.createBot({
            host: SERVER,
            port: 25565,
            username: info.username,
            auth: 'offline', // Try offline mode - server might allow it
            version: false, // Auto-detect version
        });
        
        account.online = false;
        
        bot.on('error', (err) => {
            console.error(`[${info.username}] Error: ${err.message}`);
        });
        
        bot.on('kicked', (reason) => {
            console.error(`[${info.username}] Kicked: ${reason}`);
            account.online = false;
        });
        
        bot.on('end', (reason) => {
            console.log(`[${info.username}] Disconnected: ${reason}`);
            account.online = false;
            bots.delete(info.username);
        });
        
        bot.on('login', () => {
            console.log(`[${info.username}] Logged in!`);
        });
        
        bot.on('spawn', () => {
            console.log(`[${info.username}] Spawned in game!`);
            account.online = true;
            
            // AUTO MESSAGE SYSTEM
            const queue = [];
            const cooldown = new Set();
            let lastSend = 0;
            
            bot.on('message', (msg) => {
                const text = msg.toString();
                console.log(`[${info.username}] Chat: ${text}`);
                
                if (text.includes('[AutoMsg]') || text.includes('discord.gg')) return;
                
                const name = parseName(text, bot.username);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${info.username}] Queued: ${name} (Total: ${queue.length})`);
                }
            });
            
            // Send messages every 2 seconds
            const msgInterval = setInterval(() => {
                if (!bot._client) {
                    clearInterval(msgInterval);
                    return;
                }
                
                const now = Date.now();
                if (now - lastSend >= 2000 && queue.length > 0) {
                    const target = queue.shift();
                    const random = Math.random().toString(36).substring(7);
                    
                    try {
                        bot.chat(`/msg ${target} discord.gg\\bills cheapest market ${random}`);
                        console.log(`[${info.username}] ✉️  Sent to: ${target}`);
                        
                        lastSend = now;
                        cooldown.add(target);
                        setTimeout(() => cooldown.delete(target), 5000);
                    } catch (err) {
                        console.error(`[${info.username}] Failed to send: ${err.message}`);
                    }
                }
            }, 100);
        });
        
        bots.set(info.username, bot);
        
    } catch (err) {
        console.error(`[${info.username}] Start failed: ${err.message}`);
        console.error(err.stack);
        account.online = false;
    }
}

function parseName(text, myName) {
    if (!text.includes(':')) return null;
    let name = text.split(':')[0].trim();
    name = name.replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    if (name.endsWith('+')) name = name.slice(0, -1);
    if (name === myName || name.length < 3) return null;
    return name;
}

// === API ENDPOINTS ===

app.get('/', (req, res) => {
    res.json({ status: 'running', bots: accounts.length });
});

app.get('/status', (req, res) => {
    const online = Array.from(bots.values()).filter(b => b._client && b._client.socket).length;
    res.json({ total: accounts.length, online });
});

app.post('/add', (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token required' });
        
        const info = decodeJWT(token);
        if (!info) return res.status(400).json({ error: 'Invalid token' });
        
        const acc = { token, username: info.username, online: false };
        accounts.push(acc);
        
        startBot(acc);
        res.json({ username: info.username, status: 'starting' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/startall', (req, res) => {
    let started = 0;
    accounts.forEach(a => {
        if (!bots.has(a.username)) {
            startBot(a);
            started++;
        }
    });
    res.json({ success: true, started });
});

app.post('/stopall', (req, res) => {
    bots.forEach(bot => bot.end());
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});

app.get('/list', (req, res) => {
    res.json({ accounts });
});

app.listen(PORT, () => {
    console.log(`🤖 Bot manager running on port ${PORT}`);
    console.log(`📡 Will connect to: ${SERVER}:25565`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    bots.forEach(bot => bot.end());
    process.exit(0);
});
