const mc = require('minecraft-protocol');
const express = require('express');
const app = express();
app.use(express.json());

const SERVER = process.env.SERVER_IP || 'donutsmp.net';
const PORT = process.env.PORT || 8080;

let accounts = [];
let bots = new Map();

function parseCredentials(input) {
    const parts = input.split(':');
    if (parts.length < 3) return null;
    
    const email = parts[0];
    const password = parts[1];
    const token = parts.slice(2).join(':');
    
    return { email, password, token };
}

function decodeJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length < 2) return null;
        
        const payload = JSON.parse(Buffer.from(parts[1], 'base64'));
        const profile = payload.pfd?.[0];
        
        return { 
            username: profile?.name || 'Unknown', 
            uuid: profile?.id || 'unknown-uuid'
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
            console.error('Invalid credentials format');
            return;
        }
        
        const info = decodeJWT(creds.token);
        if (!info) {
            console.error('Invalid token');
            return;
        }
        
        console.log(`Starting: ${info.username}`);
        account.username = info.username;
        account.online = false;
        
        const client = mc.createClient({
            host: SERVER,
            port: 25565,
            username: info.username,
            auth: 'microsoft',
            session: {
                accessToken: creds.token,
                clientToken: 'client-token',
                selectedProfile: {
                    id: info.uuid,
                    name: info.username
                }
            },
            version: false
        });
        
        const queue = [];
        const cooldown = new Set();
        let lastSend = 0;
        
        client.on('error', (e) => {
            console.error(`[${info.username}] Error: ${e.message}`);
            account.online = false;
        });
        
        client.on('kick_disconnect', (packet) => {
            try {
                const reason = JSON.parse(packet.reason);
                console.error(`[${info.username}] Kicked: ${reason.text || reason}`);
            } catch {
                console.error(`[${info.username}] Kicked: ${packet.reason}`);
            }
            account.online = false;
            bots.delete(info.username);
            
            // Auto-reconnect after 10 seconds
            setTimeout(() => {
                console.log(`[${info.username}] Reconnecting...`);
                startBot(account);
            }, 10000);
        });
        
        client.on('end', () => {
            console.log(`[${info.username}] Disconnected`);
            account.online = false;
            bots.delete(info.username);
            
            // Auto-reconnect
            setTimeout(() => startBot(account), 10000);
        });
        
        client.on('login', () => {
            console.log(`[${info.username}] ✅ LOGGED IN!`);
            account.online = true;
        });
        
        client.on('chat', (packet) => {
            try {
                let text = typeof packet.message === 'string' 
                    ? JSON.parse(packet.message) 
                    : packet.message;
                
                text = extractText(text);
                
                if (!text || text.includes('discord.gg') || text.includes('[AutoMsg]')) {
                    return;
                }
                
                const name = parseName(text, info.username);
                
                if (name && !cooldown.has(name) && !queue.includes(name)) {
                    queue.push(name);
                    console.log(`[${info.username}] Queued: ${name} (Total: ${queue.length})`);
                }
            } catch (e) {
                // Ignore chat parse errors
            }
        });
        
        // Message sender - runs every 100ms
        const sender = setInterval(() => {
            if (!client.socket?.writable || !account.online) return;
            
            const now = Date.now();
            
            // Send every 2 seconds
            if (now - lastSend >= 2000 && queue.length > 0) {
                const target = queue.shift();
                
                try {
                    const random = Math.random().toString(36).substring(7);
                    client.write('chat', { 
                        message: `/msg ${target} discord.gg\\bills cheapest market ${random}` 
                    });
                    
                    console.log(`[${info.username}] ✓ Sent to: ${target}`);
                    
                    lastSend = now;
                    cooldown.add(target);
                    
                    // Remove from cooldown after 5 seconds
                    setTimeout(() => cooldown.delete(target), 5000);
                } catch (e) {
                    console.error(`[${info.username}] Send error:`, e.message);
                }
            }
        }, 100);
        
        client.on('end', () => clearInterval(sender));
        
        bots.set(info.username, client);
        
    } catch (error) {
        console.error('startBot error:', error.message);
        account.online = false;
    }
}

function extractText(component) {
    if (typeof component === 'string') return component;
    if (!component) return '';
    
    let text = component.text || '';
    
    if (component.extra && Array.isArray(component.extra)) {
        component.extra.forEach(extra => {
            text += extractText(extra);
        });
    }
    
    return text;
}

function parseName(text, myName) {
    if (!text || !text.includes(':')) return null;
    
    let name = text.split(':')[0].trim();
    name = name.replace(/§./g, '').replace(/\[.*?\]/g, '').trim();
    
    if (name.endsWith('+')) {
        name = name.slice(0, -1);
    }
    
    if (!name || name === myName || name.length < 3 || name.length > 16) {
        return null;
    }
    
    return name;
}

// API Routes
app.get('/', (req, res) => {
    res.json({ status: 'Bot manager running', bots: accounts.length });
});

app.get('/status', (req, res) => {
    const online = accounts.filter(a => a.online).length;
    res.json({ 
        total: accounts.length, 
        online: online,
        offline: accounts.length - online
    });
});

app.post('/add', (req, res) => {
    const { token, username } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Token required' });
    }
    
    const acc = { 
        credentials: token, 
        username: username || 'Loading...', 
        online: false 
    };
    
    accounts.push(acc);
    
    startBot(acc);
    
    res.json({ 
        status: 'starting',
        username: acc.username
    });
});

app.post('/startall', (req, res) => {
    accounts.forEach(acc => {
        if (!bots.has(acc.username)) {
            startBot(acc);
        }
    });
    res.json({ success: true });
});

app.post('/stopall', (req, res) => {
    bots.forEach(client => {
        try {
            client.end();
        } catch (e) {}
    });
    bots.clear();
    accounts.forEach(a => a.online = false);
    res.json({ success: true });
});

app.get('/list', (req, res) => {
    res.json({ 
        accounts: accounts.map(a => ({ 
            username: a.username, 
            online: a.online 
        }))
    });
});

app.delete('/remove/:username', (req, res) => {
    const username = req.params.username;
    const bot = bots.get(username);
    
    if (bot) {
        bot.end();
        bots.delete(username);
    }
    
    accounts = accounts.filter(a => a.username !== username);
    
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Bot manager running on port ${PORT}`);
    console.log(`Server: ${SERVER}`);
});
