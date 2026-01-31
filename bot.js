const mc = require('minecraft-protocol');
const express = require('express');
const app = express();

app.use(express.json());

const bots = new Map();

function parseToken(tokenString) {
    const parts = tokenString.split(':');
    if (parts.length < 3) throw new Error('Invalid format');
    return {
        email: parts[0],
        password: parts[1],
        accessToken: parts.slice(2).join(':')
    };
}

function decodeJWT(token) {
    try {
        token = token.trim();
        const parts = token.split('.');
        let payload = parts[1];
        while (payload.length % 4 !== 0) payload += '=';
        return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (e) {
        throw new Error('JWT decode failed');
    }
}

async function createBot(botId, host, port, sessionToken) {
    try {
        console.log(`[${botId}] Starting...`);
        const { email, password, accessToken } = parseToken(sessionToken);
        
        const tokenData = decodeJWT(accessToken);
        const mcProfile = tokenData.profiles?.mc || tokenData.pfd?.[0]?.id;
        const mcName = tokenData.pfd?.[0]?.name;
        
        if (!mcName) throw new Error('No username in token');
        
        console.log(`[${botId}] Account: ${mcName}`);
        console.log(`[${botId}] UUID: ${mcProfile}`);
        
        const client = mc.createClient({
            host: host,
            port: port,
            username: mcName,
            auth: 'offline',
            version: false,
            skipValidation: true,
            hideErrors: false
        });
        
        // Session injection
        client.on('session', (session) => {
            console.log(`[${botId}] Session requested, injecting...`);
            client.session = {
                accessToken: accessToken,
                clientToken: tokenData.xuid,
                selectedProfile: {
                    id: mcProfile,
                    name: mcName
                }
            };
        });
        
        const originalWrite = client.write.bind(client);
        client.write = function(name, params) {
            if (name === 'login_start' || name === 'encryption_begin') {
                console.log(`[${botId}] Injecting session before ${name}`);
                client.session = {
                    accessToken: accessToken,
                    clientToken: tokenData.xuid,
                    selectedProfile: {
                        id: mcProfile,
                        name: mcName
                    }
                };
            }
            return originalWrite(name, params);
        };
        
        client.on('connect', () => {
            console.log(`[${botId}] 🔌 Connected to server`);
        });
        
        client.on('error', (err) => {
            console.error(`[${botId}] ❌ Error: ${err.message}`);
            console.error(`[${botId}] Stack: ${err.stack}`);
        });
        
        client.on('kick_disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`[${botId}] 🚫 KICKED: ${reason.text || JSON.stringify(reason)}`);
            } catch {
                console.error(`[${botId}] 🚫 KICKED: ${packet.reason}`);
            }
            bots.delete(botId);
        });
        
        client.on('disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.log(`[${botId}] 🔌 DISCONNECT packet: ${reason.text || JSON.stringify(reason)}`);
            } catch {
                console.log(`[${botId}] 🔌 DISCONNECT packet: ${JSON.stringify(packet)}`);
            }
            bots.delete(botId);
        });
        
        client.on('end', (reason) => {
            console.log(`[${botId}] 🔌 Connection ended: ${reason || 'Unknown reason'}`);
            bots.delete(botId);
        });
        
        client.on('login', (packet) => {
            console.log(`[${botId}] ✅✅✅ LOGGED IN! ✅✅✅`);
            console.log(`[${botId}] Login packet:`, JSON.stringify(packet, null, 2));
        });
        
        client.on('spawn_position', () => {
            console.log(`[${botId}] 🎮 SPAWNED IN GAME!`);
        });
        
        client.on('position', (packet) => {
            console.log(`[${botId}] 📍 Position update: ${JSON.stringify(packet)}`);
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                console.log(`[${botId}] 💬 Chat: ${extractText(text)}`);
            } catch {}
        });
        
        // Log ALL packets for debugging
        client.on('packet', (data, metadata) => {
            if (metadata.name !== 'keep_alive') { // Ignore keepalive spam
                console.log(`[${botId}] 📦 Packet: ${metadata.name}`);
            }
        });
        
        bots.set(botId, { client, mcName });
        
        return { success: true, mcUsername: mcName, uuid: mcProfile };
        
    } catch (error) {
        console.error(`[${botId}] ❌ Failed: ${error.message}`);
        console.error(error.stack);
        throw error;
    }
}

function extractText(c) {
    if (typeof c === 'string') return c;
    if (!c) return '';
    let text = c.text || '';
    if (c.extra) c.extra.forEach(e => text += extractText(e));
    return text;
}

app.post('/add', async (req, res) => {
    try {
        const { username, token, host = 'donutsmp.net', port = 25565 } = req.body;
        if (!username || !token) return res.status(400).json({ success: false, error: 'Missing data' });
        if (bots.has(username)) return res.status(400).json({ success: false, error: 'Already running' });
        
        const result = await createBot(username, host, port, token);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/remove', (req, res) => {
    const { username } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    bot.client.end();
    bots.delete(username);
    res.json({ success: true });
});

app.post('/chat', (req, res) => {
    const { username, message } = req.body;
    const bot = bots.get(username);
    if (!bot) return res.status(404).json({ success: false, error: 'Not found' });
    bot.client.write('chat', { message });
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    const status = Array.from(bots.entries()).map(([username, bot]) => ({
        username,
        mcUsername: bot.mcName,
        connected: bot.client.socket?.writable || false
    }));
    res.json({ success: true, count: bots.size, bots: status });
});

app.get('/', (req, res) => res.json({ status: 'online', bots: bots.size }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Running on ${PORT}`));
