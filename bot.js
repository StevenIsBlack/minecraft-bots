const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits } = require('discord.js');
const { pathfinder } = require('mineflayer-pathfinder');

// --- VARIABLES FROM YOUR IMAGES ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SERVER_HOST = 'DonutSMP.net'; // Hardcoded for your specific test
const PREFIX = '!';

const bots = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Helper: Extracts Username and UUID from the JWT Token
function parseToken(jwtToken) {
    try {
        const payload = JSON.parse(Buffer.from(jwtToken.split('.')[1], 'base64').toString());
        const username = payload.pfd?.[0]?.name;
        const uuid = payload.pfd?.[0]?.id?.replace(/-/g, '');
        return { username, uuid };
    } catch (e) {
        return null;
    }
}

async function createBot(jwtToken, message) {
    const auth = parseToken(jwtToken);
    if (!auth) return message.reply("❌ Error: Invalid Token format.");

    if (bots.has(auth.username.toLowerCase())) {
        return message.reply(`⚠️ **${auth.username}** is already online.`);
    }

    message.channel.send(`🔗 Connecting **${auth.username}** to DonutSMP...`);

    const bot = mineflayer.createBot({
        host: SERVER_HOST,
        port: 25565,
        version: false, // Auto-detect version for 1.21+
        username: auth.username,
        session: {
            accessToken: jwtToken,
            clientToken: auth.uuid,
            selectedProfile: { id: auth.uuid, name: auth.username }
        },
        auth: 'microsoft',
        skipValidation: true
    });

    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
        bots.set(auth.username.toLowerCase(), bot);
        message.channel.send(`✅ **${auth.username}** has joined the server!`);
    });

    bot.on('error', (err) => message.channel.send(`❌ [${auth.username}] Error: ${err.message}`));
    
    bot.on('kicked', (reason) => {
        const cleanReason = reason.replace(/§./g, ''); // Remove color codes
        message.channel.send(`⚠️ [${auth.username}] Kicked: ${cleanReason}`);
    });

    bot.on('end', () => {
        bots.delete(auth.username.toLowerCase());
        message.channel.send(`🔌 **${auth.username}** disconnected.`);
    });
}

// --- DISCORD COMMANDS ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // !add <token>
    if (command === 'add') {
        const token = args[0];
        if (!token) return message.reply("Usage: `!add <token>`");
        createBot(token, message);
    }

    // !cmd <botname> <command>
    if (command === 'cmd') {
        const targetBot = args[0]?.toLowerCase();
        const mcAction = args.slice(1).join(' ');

        if (!targetBot || !mcAction) return message.reply("Usage: `!cmd <bot_username> <command>`");

        const bot = bots.get(targetBot);
        if (bot) {
            bot.chat(mcAction);
            message.react('✔️');
        } else {
            message.reply(`❌ Bot **${targetBot}** is not connected.`);
        }
    }
});

client.login(DISCORD_TOKEN);
console.log("Discord Bot is starting...");
