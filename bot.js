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
        return {
            username: profile.name,
            uuid: profile.id,
            token: token
        };
    } catch (err) {
        return null;
    }
}

async function startBot(account) {
    const info = decodeJWT(account.token);
    if (!info) {
        console.error('Invalid token');
        return;
    }
    
    console.log(`Starting bot: ${info.username}`);
    account.username = info.username;
    
    try {
        // Try using mineflayer with manual session injection
        const bot = mineflayer.createBot({
            host: SERVER,
            port: 25565,
            username: info.username,
            // Provide the session directly - bypass all auth
            accessToken: account.token,
            clientToken: info.uuid,
            // Critical: tell mineflayer to skip validation
            skipValidation: true,
            auth: 'microsoft',
            profilesFolder: './auth_cache',
            version: false,
        });
        
        // Force override the session BEFORE connection
        bot.session = {
            accessToken: account.token,
            clientToken: info.uuid,
            selectedProfile: {
                id: info.uuid,
                name: info.username
            }
        };
        
        account.online = false;
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        bot.on('error', (err) => {
            console.error(`[${info.username}] Error: ${err.message}`);
        });
        
        bot.on('kicked', (reason) => {
            console.error(`[${info.username}] Kicked: ${reason}`);
            account.online = false;
        });
        
        bot.on('end', () => {
            console.log(`[${info.username}] Disconnected`);
            account.online = false;
            bots.delete(info.username);
        });
        
        bot.on('login', () => {
            console.log(`[${info.username}] ✅ Logged in!`);
            account.online = true;
        });
        
        bot.on('spawn', () => {
            console.log(`[${info.username}] 🎮 Spawned!`);
            account.online = true;
        });
        
        bot.on('messagestr', (message) => {
            if (message.includes('discord.gg')) return;
            
            const name = parseName(message, info.username);
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
                console.log(`[${info.username}] 📥 Queued: ${name}`);
            }
        });
        
        setInterval(() => {
            if (!bot._client || !bot._client.socket) return;
            
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = Math.random().toString(36).substring(7);
                
                try {
                    bot.chat(`/msg ${target} discord.gg\\bills cheapest market ${random}`);
                    console.log(`[${info.username}] 📨 Sent to: ${target}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (err) {
                    console.error(`Send failed`);
                }
            }
        }, 100);
        
        bots.set(info.username, bot);
        
    } catch (err) {
        console.error(`[${info.username}] Failed: ${err.message}`);
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

app.get('/status', (req, res) => {
    const online = accounts.filter(a => a.online).length;
    res.json({ total: accounts.length, online });
});

app.post('/add', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token required' });
        
        const acc = { token, username: 'Loading...', online: false };
        accounts.push(acc);
        
        startBot(acc);
        
        res.json({ status: 'starting' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/stopall', (req, res) => {
    bots.forEach(bot => bot.end());
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});

app.get('/list', (req, res) => {
    const list = accounts.map(a => ({
        username: a.username,
        online: a.online
    }));
    res.json({ accounts: list });
});

app.listen(PORT, () => {
    console.log(`🤖 Bot manager running on port ${PORT}`);
});
