const mc = require('minecraft-protocol');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

console.log('=================================');
console.log('Minecraft Bot Manager Starting...');
console.log('Server:', SERVER);
console.log('Port:', PORT);
console.log('=================================');

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
        const parts = token.split('.');
        if (parts.length < 2) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64'));
        const profile = payload.pfd?.[0];
        return { 
            username: profile?.name || 'Bot' + Date.now(), 
            uuid: profile?.id || 'uuid'
        };
    } catch (e) {
        console.error('JWT decode error:', e.message);
        return null;
    }
}

async function startBot(account) {
    try {
        const creds = parseCredentials(account.credentials);
        if (!creds) {
            console.error('Invalid credentials');
            return;
        }
        
        const info = decodeJWT(creds.token);
        if (!info) {
            console.error('Invalid token');
            return;
        }
        
        console.log(`[${info.username}] Starting bot...`);
        account.username = info.username;
        account.online = false;
        
        const client = mc.createClient({
            host: SERVER,
            port: 25565,
            username: info.username,
            auth: 'microsoft',
            session: {
                accessToken: creds.token,
                clientToken: 'client',
                selectedProfile: {
                    id: info.uuid,
                    name: info.username
                }
            }
        });
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        client.on('error', (e) => {
            console.error(`[${info.username}] Error: ${e.message}`);
        });
        
        client.on('end', () => {
            console.log(`[${info.username}] Disconnected, reconnecting in 10s...`);
            account.online = false;
            bots.delete(info.username);
            setTimeout(() => startBot(account), 10000);
        });
        
        client.on('login', () => {
            console.log(`[${info.username}] ✅ LOGGED IN`);
            account.online = true;
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' 
                    ? JSON.parse(packet.message) 
                    : packet.message;
                
                text = extractText(text);
                if (!text || text.includes('discord.gg')) return;
                
                const name = parseName(text, info.username);
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                }
            } catch {}
        });
        
        setInterval(() => {
            if (!client.socket?.writable) return;
            const now = Date.now();
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                try {
                    const rand = Math.random().toString(36).substring(7);
                    client.write('chat', { 
                        message: `/msg ${target} discord.gg\\bills cheapest market ${rand}` 
                    });
                    lastSend = now;
                    cooldown.add(target);
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch {}
            }
        }, 100);
        
        bots.set(info.username, client);
        
    } catch (error) {
        console.error('startBot error:', error);
    }
}

function extractText(c) {
    if (typeof c === 'string') return c;
    if (!c) return '';
    let text = c.text || '';
    if (c.extra) c.extra.forEach(e => text += extractText(e));
    return text;
}

function parseName(text, myName) {
    if (!text?.includes(':')) return null;
    let name = text.split(':')[0].trim().replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    if (name.endsWith('+')) name = name.slice(0, -1);
    return (name === myName || name.length < 3) ? null : name;
}

// Routes
app.get('/', (req, res) => {
    console.log('GET / - Health check');
    res.json({ status: 'running', accounts: accounts.length, online: accounts.filter(a => a.online).length });
});

app.get('/status', (req, res) => {
    console.log('GET /status');
    const online = accounts.filter(a => a.online).length;
    res.json({ total: accounts.length, online: online, offline: accounts.length - online });
});

app.post('/add', (req, res) => {
    console.log('POST /add');
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    
    const acc = { credentials: token, username: 'Loading...', online: false };
    accounts.push(acc);
    startBot(acc);
    
    res.json({ status: 'starting', username: acc.username });
});

app.post('/startall', (req, res) => {
    console.log('POST /startall');
    accounts.forEach(a => {
        if (!bots.has(a.username)) startBot(a);
    });
    res.json({ success: true, message: 'Starting all bots' });
});

app.post('/stopall', (req, res) => {
    console.log('POST /stopall');
    bots.forEach(c => c.end());
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true, message: 'Stopped all bots' });
});

app.get('/list', (req, res) => {
    console.log('GET /list');
    res.json({ accounts: accounts.map(a => ({ username: a.username, online: a.online })) });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log(`✅ Bot Manager Running on Port ${PORT}`);
    console.log('=================================');
});
