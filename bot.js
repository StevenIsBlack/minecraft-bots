const mc = require('minecraft-protocol');
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

async function startBot(account) {
    const info = decodeJWT(account.token);
    if (!info) {
        console.error('Invalid token');
        return;
    }
    
    console.log(`Starting bot: ${info.username}`);
    account.username = info.username;
    
    try {
        const client = mc.createClient({
            host: SERVER,
            port: 25565,
            username: info.username,
            auth: 'microsoft',
            session: {
                accessToken: info.accessToken,
                clientToken: info.uuid,
                selectedProfile: {
                    id: info.uuid,
                    name: info.username
                }
            },
            skipValidation: true,
            version: false,
        });
        
        account.online = false;
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        client.on('error', (err) => {
            console.error(`[${info.username}] Error: ${err.message}`);
        });
        
        client.on('kick_disconnect', (packet) => {
            const reason = JSON.parse(packet.reason);
            console.error(`[${info.username}] Kicked: ${JSON.stringify(reason)}`);
            account.online = false;
        });
        
        client.on('end', () => {
            console.log(`[${info.username}] Disconnected`);
            account.online = false;
            bots.delete(info.username);
        });
        
        client.on('login', () => {
            console.log(`[${info.username}] ✅ Logged in!`);
            account.online = true;
        });
        
        client.on('chat', (packet) => {
            try {
                const msg = JSON.parse(packet.message);
                const text = msg.text || msg.translate || '';
                
                if (text.includes('[AutoMsg]') || text.includes('discord.gg')) return;
                
                const name = parseName(text, info.username);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${info.username}] 📥 Queued: ${name}`);
                }
            } catch (e) {}
        });
        
        setInterval(() => {
            if (!client.socket || !client.socket.writable) return;
            
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                const random = Math.random().toString(36).substring(7);
                
                try {
                    client.write('chat', {
                        message: `/msg ${target} discord.gg\\bills cheapest market ${random}`
                    });
                    console.log(`[${info.username}] 📨 Sent to: ${target}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (err) {
                    console.error(`[${info.username}] Send failed: ${err.message}`);
                }
            }
        }, 100);
        
        bots.set(info.username, client);
        
    } catch (err) {
        console.error(`[${info.username}] Failed: ${err.message}`);
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

app.get('/', (req, res) => {
    res.json({ status: 'running', bots: accounts.length });
});

app.get('/status', (req, res) => {
    const online = accounts.filter(a => a.online).length;
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
        if (!a.online) {
            startBot(a);
            started++;
        }
    });
    res.json({ success: true, started });
});

app.post('/stopall', (req, res) => {
    bots.forEach(client => client.end());
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

process.on('SIGTERM', () => {
    console.log('Shutting down...');
    bots.forEach(client => client.end());
    process.exit(0);
});
