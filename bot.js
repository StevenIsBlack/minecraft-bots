const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

// Parse the email:password:token format
function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 3) {
        return null;
    }
    
    return {
        email: parts[0],
        password: parts[1],
        token: parts.slice(2).join(':') // In case password has colons
    };
}

// Custom authflow that uses the token to bypass 2FA
class TokenAuthflow extends Authflow {
    constructor(username, cacheDir, token) {
        super(username, cacheDir, {
            authTitle: Titles.MinecraftJava,
            flow: 'live',
        });
        this.xboxToken = token;
    }
    
    // Override to use our existing Xbox token
    async getXboxToken() {
        console.log('Using provided Xbox token instead of interactive login');
        
        // Decode the token to get user hash
        try {
            const payload = JSON.parse(Buffer.from(this.xboxToken.split('.')[1], 'base64').toString());
            return {
                userHash: payload.xuid,
                XSTSToken: this.xboxToken,
                expiresOn: payload.exp * 1000
            };
        } catch (err) {
            console.error('Failed to use token, falling back to normal auth');
            return await super.getXboxToken();
        }
    }
}

async function startBot(account) {
    const creds = parseCredentials(account.credentials);
    if (!creds) {
        console.error('Invalid credentials format');
        return;
    }
    
    console.log(`Starting bot with email: ${creds.email}`);
    
    try {
        // Create cache directory
        if (!fs.existsSync('./auth_cache')) {
            fs.mkdirSync('./auth_cache', { recursive: true });
        }
        
        // Use custom authflow with token
        const authflow = new TokenAuthflow(creds.email, './auth_cache', creds.token);
        
        const bot = mineflayer.createBot({
            host: SERVER,
            port: 25565,
            auth: 'microsoft',
            authflow: authflow,
            profilesFolder: './auth_cache',
            version: false,
        });
        
        account.online = false;
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        bot.on('error', (err) => {
            console.error(`[${creds.email}] Error: ${err.message}`);
        });
        
        bot.on('kicked', (reason) => {
            console.error(`[${creds.email}] Kicked: ${reason}`);
            account.online = false;
        });
        
        bot.on('end', () => {
            console.log(`[${creds.email}] Disconnected`);
            account.online = false;
            if (account.username) {
                bots.delete(account.username);
            }
        });
        
        bot.on('login', () => {
            console.log(`[${bot.username}] ✅ Logged in!`);
            account.username = bot.username;
            account.online = true;
        });
        
        bot.on('spawn', () => {
            console.log(`[${bot.username}] 🎮 Spawned!`);
        });
        
        bot.on('messagestr', (message) => {
            if (message.includes('discord.gg')) return;
            
            const name = parseName(message, bot.username);
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
                console.log(`[${bot.username}] 📥 Queued: ${name}`);
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
                    console.log(`[${bot.username}] 📨 Sent to: ${target}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (err) {}
            }
        }, 100);
        
        bots.set(creds.email, bot);
        
    } catch (err) {
        console.error(`Failed to start bot: ${err.message}`);
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
        
        const creds = parseCredentials(token);
        if (!creds) {
            return res.status(400).json({ error: 'Invalid format. Use: email:password:token' });
        }
        
        const acc = { credentials: token, username: 'Loading...', online: false };
        accounts.push(acc);
        
        startBot(acc);
        
        res.json({ email: creds.email, status: 'starting' });
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
    console.log(`📡 Will connect to: ${SERVER}:25565`);
});
