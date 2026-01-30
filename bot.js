const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 3000;

let accounts = [];
let bots = new Map();

function decodeToken(token) {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const profile = payload.pfd?.[0];
    return {
        username: profile.name,
        uuid: profile.id
    };
}

function startBot(account) {
    try {
        const info = decodeToken(account.token);
        
        const bot = mineflayer.createBot({
            host: SERVER,
            port: 25565,
            username: info.username,
            session: {
                accessToken: account.token,
                selectedProfile: {
                    name: info.username,
                    id: info.uuid
                }
            },
            auth: 'offline', // Try offline first since we have token
            skipValidation: true
        });
        
        account.online = false;
        account.username = info.username;
        
        bot.on('error', (err) => {
            console.log(`[${info.username}] Error:`, err.message);
        });
        
        bot.on('end', () => {
            console.log(`[${info.username}] Disconnected`);
            account.online = false;
            bots.delete(info.username);
        });
        
        bot.on('spawn', () => {
            console.log(`[${info.username}] Spawned!`);
            account.online = true;
            
            const queue = [];
            const cooldown = new Set();
            let lastSend = 0;
            
            bot.on('message', (msg) => {
                const text = msg.toString();
                if (text.includes('[AutoMsg]') || text.includes('discord.gg')) return;
                
                const name = parseName(text, bot.username);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                }
            });
            
            setInterval(() => {
                const now = Date.now();
                if (now - lastSend >= 2000 && queue.length > 0) {
                    const target = queue.shift();
                    const random = Math.random().toString(36).substring(7);
                    
                    bot.chat(`/msg ${target} discord.gg\\bills cheapest market ${random}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                }
            }, 100);
        });
        
        bots.set(info.username, bot);
        
    } catch (err) {
        console.error(`Bot start failed:`, err.message);
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
    const online = Array.from(bots.values()).filter(b => b._client).length;
    res.json({ total: accounts.length, online });
});

app.post('/add', (req, res) => {
    const { token } = req.body;
    const acc = { token, online: false };
    accounts.push(acc);
    startBot(acc);
    res.json({ success: true });
});

app.post('/startall', (req, res) => {
    accounts.forEach(a => {
        if (!bots.has(a.username)) startBot(a);
    });
    res.json({ success: true });
});

app.post('/stopall', (req, res) => {
    bots.forEach(bot => bot.end());
    bots.clear();
    res.json({ success: true });
});

app.get('/list', (req, res) => {
    res.json({ accounts });
});

app.listen(PORT, () => console.log(`Running on ${PORT}`));
