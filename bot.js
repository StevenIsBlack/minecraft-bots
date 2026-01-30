const mineflayer = require('mineflayer');
const { Authflow, Titles } = require('prismarine-auth');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 3) return null;
    return {
        email: parts[0],
        password: parts[1],
        token: parts.slice(2).join(':')
    };
}

function decodeJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        const profile = payload.pfd?.[0];
        return {
            username: profile?.name,
            uuid: profile?.id,
            xuid: payload.xuid
        };
    } catch {
        return null;
    }
}

// Create fake cached auth to bypass interactive login
async function createCachedAuth(email, xboxToken, info) {
    const cacheDir = './auth_cache';
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    const cacheFile = path.join(cacheDir, `${email}.json`);
    
    // Create a fake cache that prismarine-auth will use
    const fakeCache = {
        msa: {
            token: xboxToken,
            expires_at: Date.now() + 86400000 // 24 hours
        },
        xbl: {
            token: xboxToken,
            userHash: info.xuid,
            expires_at: Date.now() + 86400000
        },
        xsts: {
            token: xboxToken,
            userHash: info.xuid,
            expires_at: Date.now() + 86400000
        },
        mca: {
            access_token: xboxToken,
            expires_at: Date.now() + 86400000,
            profile: {
                id: info.uuid,
                name: info.username
            }
        }
    };
    
    fs.writeFileSync(cacheFile, JSON.stringify(fakeCache));
    console.log(`Created cached auth for ${email}`);
}

async function startBot(account) {
    const creds = parseCredentials(account.credentials);
    if (!creds) return;
    
    const info = decodeJWT(creds.token);
    if (!info) return;
    
    console.log(`\n🚀 Starting: ${info.username}`);
    account.username = info.username;
    
    try {
        // Create fake cache
        await createCachedAuth(creds.email, creds.token, info);
        
        // Use authflow which will read the cache
        const authflow = new Authflow(creds.email, './auth_cache', {
            authTitle: Titles.MinecraftJava,
            flow: 'live',
            // This should prevent interactive login
        });
        
        const bot = mineflayer.createBot({
            host: SERVER,
            port: 25565,
            auth: 'microsoft',
            authflow: authflow,
            version: false,
        });
        
        account.online = false;
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        bot.on('error', (err) => console.error(`[${info.username}] Error: ${err.message}`));
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
            console.log(`[${info.username}] ✅ LOGGED IN!`);
            account.online = true;
        });
        bot.on('spawn', () => console.log(`[${info.username}] 🎮 Spawned!`));
        bot.on('messagestr', (message) => {
            if (message.includes('discord.gg')) return;
            const name = parseName(message, info.username);
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
                console.log(`[${info.username}] Queued: ${name}`);
            }
        });
        
        setInterval(() => {
            if (!bot._client?.socket) return;
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                try {
                    bot.chat(`/msg ${target} discord.gg\\bills cheapest market ${Math.random().toString(36).substring(7)}`);
                    console.log(`[${info.username}] Sent to: ${target}`);
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch {}
            }
        }, 100);
        
        bots.set(info.username, bot);
    } catch (err) {
        console.error(`Failed: ${err.message}`);
        account.online = false;
    }
}

function parseName(text, myName) {
    if (!text.includes(':')) return null;
    let name = text.split(':')[0].trim().replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    if (name.endsWith('+')) name = name.slice(0, -1);
    if (name === myName || name.length < 3) return null;
    return name;
}

app.get('/status', (req, res) => res.json({ total: accounts.length, online: accounts.filter(a => a.online).length }));
app.post('/add', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const acc = { credentials: token, username: 'Loading...', online: false };
    accounts.push(acc);
    startBot(acc);
    res.json({ status: 'starting' });
});
app.post('/stopall', (req, res) => {
    bots.forEach(bot => bot.end());
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});
app.get('/list', (req, res) => res.json({ accounts: accounts.map(a => ({ username: a.username, online: a.online })) }));

app.listen(PORT, () => console.log(`🤖 Running on ${PORT}`));
