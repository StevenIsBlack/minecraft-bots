const mineflayer = require('mineflayer');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = 'donutsmp.net'; // CHANGE THIS TO YOUR SERVER
let accounts = [];
let bots = new Map();

// Create a Minecraft bot
function startBot(username, token) {
    const bot = mineflayer.createBot({
        host: SERVER,
        port: 25565,
        username: username,
        auth: 'microsoft',
        password: token
    });
    
    // Auto-reconnect if kicked
    bot.on('end', () => {
        console.log('Reconnecting...');
        setTimeout(() => startBot(username, token), 5000);
    });
    
    // When bot joins server
    bot.on('spawn', () => {
        console.log(`${username} joined!`);
        
        // AUTO MESSAGE SYSTEM
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        // Listen to chat
        bot.on('message', (msg) => {
            const text = msg.toString();
            const name = extractName(text, username);
            
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
            }
        });
        
        // Send messages every 2 seconds
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
    
    bots.set(username, bot);
}

function extractName(text, myName) {
    if (!text.includes(':')) return null;
    let name = text.split(':')[0].trim();
    name = name.replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    if (name === myName || name.length < 3) return null;
    return name;
}

// API Routes
app.get('/status', (req, res) => {
    res.json({ total: accounts.length, online: bots.size });
});

app.post('/add', (req, res) => {
    const { token } = req.body;
    const username = 'Bot' + (accounts.length + 1);
    
    accounts.push({ username, token });
    startBot(username, token);
    
    res.json({ username });
});

app.post('/startall', (req, res) => {
    accounts.forEach(a => startBot(a.username, a.token));
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

app.listen(3000, () => console.log('Bot manager ready!'));
