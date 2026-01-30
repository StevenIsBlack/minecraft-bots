const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 3000;

let accounts = [];
let bots = new Map();

// Your AutoMsg logic
function startBot(account) {
    try {
        const bot = mineflayer.createBot({
            host: SERVER,
            port: 25565,
            username: account.username,
            auth: 'microsoft',
            session: {
                accessToken: account.token,
                clientToken: 'client-token',
                selectedProfile: {
                    name: account.username,
                    id: 'uuid-here'
                }
            }
        });
        
        account.online = false;
        
        bot.on('error', (err) => console.log(`[${account.username}] Error:`, err.message));
        
        bot.on('end', () => {
            console.log(`[${account.username}] Disconnected, reconnecting in 5s...`);
            account.online = false;
            bots.delete(account.username);
            setTimeout(() => startBot(account), 5000);
        });
        
        bot.on('spawn', () => {
            console.log(`[${account.username}] Spawned!`);
            account.online = true;
            
            // AUTO MESSAGE SYSTEM (Your code!)
            const queue = [];
            const cooldown = new Set();
            let lastSend = 0;
            
            bot.on('message', (msg) => {
                const text = msg.toString();
                if (text.includes('[AutoMsg]')) return;
                
                const name = parseName(text, account.username);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                }
            });
            
            // Send every 2 seconds
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
        
        bots.set(account.username, bot);
        
    } catch (err) {
        console.error(`[${account.username}] Failed:`, err.message);
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

// API
app.get('/status', (req, res) => {
    const online = Array.from(bots.values()).filter(b => b._client).length;
    res.json({ total: accounts.length, online });
});

app.post('/add', (req, res) => {
    const { token, username } = req.body;
    const name = username || 'Bot' + accounts.length;
    
    const acc = { username: name, token, online: false };
    accounts.push(acc);
    
    startBot(acc);
    res.json({ username: name });
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
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});

app.get('/list', (req, res) => {
    res.json({ accounts });
});

app.listen(PORT, () => {
    console.log(`Bot manager running on port ${PORT}`);
});
