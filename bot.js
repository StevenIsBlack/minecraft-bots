const mc = require('minecraft-protocol');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

function parseCredentials(input) {
    const [email, password, ...tokenParts] = input.split(':');
    return { email, password, token: tokenParts.join(':') };
}

function decodeJWT(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64'));
        const profile = payload.pfd?.[0];
        return { username: profile?.name, uuid: profile?.id };
    } catch { return null; }
}

async function startBot(account) {
    const creds = parseCredentials(account.credentials);
    const info = decodeJWT(creds.token);
    if (!info) return;
    
    console.log(`Starting: ${info.username}`);
    account.username = info.username;
    
    const client = mc.createClient({
        host: SERVER,
        port: 25565,
        username: info.username,
        auth: 'offline',
        version: false,
        // Inject session after connection
        onMsaCode: () => {} // Prevent interactive auth
    });
    
    // Force inject session
    client.on('connect', () => {
        console.log(`Injecting session for ${info.username}`);
        client.session = {
            accessToken: creds.token,
            selectedProfile: { id: info.uuid, name: info.username }
        };
    });
    
    account.online = false;
    const queue = [];
    const cooldown = new Set();
    let lastSend = 0;
    
    client.on('error', e => console.error(`[${info.username}] Error: ${e.message}`));
    client.on('kick_disconnect', p => {
        try {
            const reason = JSON.parse(p.reason);
            console.error(`[${info.username}] Kicked: ${reason.text}`);
        } catch { console.error(`[${info.username}] Kicked`); }
        account.online = false;
    });
    client.on('end', () => {
        console.log(`[${info.username}] Disconnected`);
        account.online = false;
        bots.delete(info.username);
    });
    client.on('login', () => {
        console.log(`[${info.username}] ✅ LOGGED IN!`);
        account.online = true;
    });
    client.on('chat', p => {
        try {
            let text = typeof p.message === 'string' ? JSON.parse(p.message) : p.message;
            text = extractText(text);
            if (!text || text.includes('discord.gg')) return;
            const name = parseName(text, info.username);
            if (name && !cooldown.has(name) && !queue.includes(name)) {
                queue.push(name);
                console.log(`[${info.username}] Queued: ${name}`);
            }
        } catch {}
    });
    
    setInterval(() => {
        if (!client.socket?.writable) return;
        const now = Date.now();
        if (now - lastSend >= 2000 && queue.length > 0) {
            const target = queue.shift();
            try {
                client.write('chat', { message: `/msg ${target} discord.gg\\bills cheapest market ${Math.random().toString(36).substring(7)}` });
                console.log(`[${info.username}] Sent to: ${target}`);
                lastSend = now;
                cooldown.add(target);
                setTimeout(() => cooldown.delete(target), 5000);
            } catch {}
        }
    }, 100);
    
    bots.set(info.username, client);
}

function extractText(c) {
    if (typeof c === 'string') return c;
    if (!c) return '';
    let text = c.text || '';
    if (c.extra) c.extra.forEach(e => text += extractText(e));
    return text;
}

function parseName(text, myName) {
    if (!text.includes(':')) return null;
    let name = text.split(':')[0].trim().replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    if (name.endsWith('+')) name = name.slice(0, -1);
    return (name === myName || name.length < 3) ? null : name;
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
    bots.forEach(c => c.end());
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});
app.get('/list', (req, res) => res.json({ accounts: accounts.map(a => ({ username: a.username, online: a.online })) }));

app.listen(PORT, () => console.log(`Running on ${PORT}`));
