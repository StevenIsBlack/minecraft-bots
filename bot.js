const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BOT_API_URL = process.env.BOT_API_URL;
const CLIENT_ID = process.env.CLIENT_ID;

if (!DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN not set!');
    process.exit(1);
}

if (!BOT_API_URL) {
    console.error('❌ BOT_API_URL not set!');
    process.exit(1);
}

if (!CLIENT_ID) {
    console.error('❌ CLIENT_ID not set!');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('vouch')
        .setDescription('Get vouching information'),
    
    new SlashCommandBuilder()
        .setName('website')
        .setDescription('Get website information'),
    
    new SlashCommandBuilder()
        .setName('rewards')
        .setDescription('Get rewards information'),
    
    new SlashCommandBuilder()
        .setName('add')
        .setDescription('Add a bot with TheAltening token')
        .addStringOption(option =>
            option.setName('token')
                .setDescription('TheAltening token')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a specific bot')
        .addStringOption(option =>
            option.setName('botid')
                .setDescription('Bot ID to remove')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('stopall')
        .setDescription('⛔ Stop ALL running bots'),
    
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('📊 View detailed bot statistics'),
    
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('📋 Beautiful list of all active bots'),
    
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('📖 Show all available commands'),
    
    new SlashCommandBuilder()
        .setName('forcemsg')
        .setDescription('Force send message to a player')
        .addStringOption(option =>
            option.setName('botid')
                .setDescription('Bot ID')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('player')
                .setDescription('Player to message')
                .setRequired(true)),
].map(command => command.toJSON());

// Register slash commands
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }
})();

async function callBotAPI(endpoint, data = {}) {
    try {
        const response = await axios.post(`${BOT_API_URL}${endpoint}`, data, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        console.error(`API Error [${endpoint}]:`, error.message);
        throw new Error(error.response?.data?.error || error.message);
    }
}

function generateBotId(token) {
    return 'bot_' + Date.now().toString().slice(-6);
}

client.on('ready', () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}`);
    console.log(`🔗 Connected to MC Bot API: ${BOT_API_URL}`);
    client.user.setActivity('!help or /help', { type: 3 });
});

// SLASH COMMANDS
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'vouch': {
                const embed = new EmbedBuilder()
                    .setColor(0x00ff00)
                    .setTitle('⭐ Thank You for Your Purchase!')
                    .setDescription(`Please leave a vouch in <#1449355333637115904>`)
                    .setFooter({ text: 'DonutMarket - Trusted Service' })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed] });
                break;
            }

            case 'website': {
                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('🌐 Visit Our Website')
                    .setDescription('[Click here to visit DonutMarket](https://www.donutmarket.eu/)')
                    .setFooter({ text: 'DonutMarket.eu' })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed] });
                break;
            }

            case 'rewards': {
                const embed = new EmbedBuilder()
                    .setColor(0xffd700)
                    .setTitle('🎁 Rewards Program')
                    .setDescription(`Thank you for inviting! Claim your rewards in <#1447280588842336368>`)
                    .setFooter({ text: 'Invite friends to earn more!' })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [embed] });
                break;
            }

            case 'add': {
                const token = interaction.options.getString('token');
                const botId = generateBotId(token);

                await interaction.deferReply();

                try {
                    const result = await callBotAPI('/add', {
                        username: botId,
                        token: token,
                        host: 'donutsmp.net',
                        port: 25565
                    });

                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle('✅ Bot Started Successfully')
                        .setDescription('Your bot is now connecting to DonutSMP!')
                        .addFields(
                            { name: '🆔 Bot ID', value: `\`${botId}\``, inline: true },
                            { name: '👤 MC Username', value: result.mcUsername || 'Loading...', inline: true },
                            { name: '🌐 Proxy', value: result.proxy || 'Direct', inline: true }
                        )
                        .setFooter({ text: `Use /remove ${botId} to stop this bot` })
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    await interaction.editReply(`❌ Failed: ${error.message}`);
                }
                break;
            }

            case 'remove': {
                const botId = interaction.options.getString('botid');

                try {
                    await callBotAPI('/remove', { username: botId });
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff9900)
                        .setTitle('🛑 Bot Stopped')
                        .setDescription(`Bot **${botId}** has been successfully stopped`)
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    await interaction.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'stopall': {
                await interaction.deferReply();
                
                try {
                    const result = await callBotAPI('/stopall', {});
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('⛔ All Bots Stopped')
                        .setDescription(`Successfully stopped **${result.stopped || 0}** bot(s)`)
                        .setTimestamp();
                    
                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    await interaction.editReply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'status': {
                try {
                    const response = await axios.get(`${BOT_API_URL}/status`, { timeout: 10000 });
                    const { bots = [], count = 0 } = response.data;

                    if (count === 0) {
                        const embed = new EmbedBuilder()
                            .setColor(0x808080)
                            .setTitle('📊 Bot Status')
                            .setDescription('No bots running\n\nUse `/add <token>` to start!')
                            .setTimestamp();
                        
                        return interaction.reply({ embeds: [embed] });
                    }

                    const onlineBots = bots.filter(b => b.connected).length;

                    const embed = new EmbedBuilder()
                        .setColor(0x0099ff)
                        .setTitle('📊 Bot Manager Status')
                        .setDescription(`**Total:** ${count} | **Online:** ${onlineBots}`)
                        .setTimestamp();

                    bots.forEach((bot, index) => {
                        if (index < 25) {
                            const statusIcon = bot.connected ? '🟢' : '🔴';
                            embed.addFields({
                                name: `${statusIcon} ${bot.mcUsername || 'Unknown'}`,
                                value: `ID: \`${bot.username}\`\nQueue: ${bot.queue || 0} | Proxy: ${bot.proxy || 'None'}`,
                                inline: true
                            });
                        }
                    });

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    await interaction.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'list': {
                try {
                    const response = await axios.get(`${BOT_API_URL}/status`, { timeout: 10000 });
                    const { bots = [], count = 0 } = response.data;

                    if (count === 0) {
                        return interaction.reply('📋 No bots running');
                    }

                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle(`📋 Active Bots (${count})`)
                        .setTimestamp();

                    let description = '';
                    bots.forEach((bot) => {
                        const statusIcon = bot.connected ? '🟢' : '🔴';
                        description += `${statusIcon} **${bot.mcUsername || 'Unknown'}**\n`;
                        description += `└ ID: \`${bot.username}\` | Queue: ${bot.queue || 0}\n\n`;
                    });

                    embed.setDescription(description);
                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    await interaction.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'help': {
                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('📖 Bot Manager Commands')
                    .addFields(
                        { name: '/add <token>', value: 'Start a bot', inline: false },
                        { name: '/remove <botid>', value: 'Stop a bot', inline: false },
                        { name: '/stopall', value: 'Stop ALL bots', inline: false },
                        { name: '/status', value: 'View bot stats', inline: false },
                        { name: '/list', value: 'List all bots', inline: false },
                        { name: '/forcemsg <botid> <player>', value: 'Force message', inline: false },
                        { name: '\u200B', value: '**Also works with ! commands**', inline: false }
                    )
                    .setFooter({ text: 'DonutMarket Bot Manager' })
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
                break;
            }

            case 'forcemsg': {
                const botId = interaction.options.getString('botid');
                const player = interaction.options.getString('player');

                try {
                    await callBotAPI('/forcemsg', { username: botId, target: player });
                    await interaction.reply(`✅ Sent message to **${player}** from **${botId}**`);
                } catch (error) {
                    await interaction.reply(`❌ Error: ${error.message}`);
                }
                break;
            }
        }
    } catch (error) {
        console.error('Command error:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(`❌ Error: ${error.message}`);
        } else {
            await interaction.reply(`❌ Error: ${error.message}`);
        }
    }
});

// ! COMMANDS (THESE WORK TOO!)
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    try {
        switch (command) {
            case 'add': {
                const token = args.join(' ');
                const botId = generateBotId(token);

                try {
                    await message.delete();
                } catch {}

                const loadingMsg = await message.channel.send(`⏳ Starting bot **${botId}**...`);

                try {
                    const result = await callBotAPI('/add', {
                        username: botId,
                        token: token,
                        host: 'donutsmp.net',
                        port: 25565
                    });

                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle('✅ Bot Started')
                        .addFields(
                            { name: 'Bot ID', value: botId, inline: true },
                            { name: 'Username', value: result.mcUsername || 'Unknown', inline: true }
                        );

                    await loadingMsg.edit({ content: null, embeds: [embed] });
                } catch (error) {
                    await loadingMsg.edit(`❌ Failed: ${error.message}`);
                }
                break;
            }

            case 'stopall': {
                try {
                    const result = await callBotAPI('/stopall', {});
                    await message.reply(`⛔ Stopped **${result.stopped || 0}** bot(s)`);
                } catch (error) {
                    await message.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'remove':
            case 'stop': {
                const botId = args[0];
                if (!botId) return message.reply('Usage: `!remove <botid>`');

                try {
                    await callBotAPI('/remove', { username: botId });
                    await message.reply(`✅ Stopped bot **${botId}**`);
                } catch (error) {
                    await message.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'status': {
                try {
                    const response = await axios.get(`${BOT_API_URL}/status`, { timeout: 10000 });
                    const { bots = [], count = 0 } = response.data;

                    if (count === 0) return message.reply('📊 No bots running');

                    const embed = new EmbedBuilder()
                        .setColor(0x0099ff)
                        .setTitle(`📊 Active Bots (${count})`)
                        .setTimestamp();

                    bots.forEach(bot => {
                        const status = bot.connected ? '🟢' : '🔴';
                        embed.addFields({
                            name: `${bot.mcUsername}`,
                            value: `${status} ${bot.username}`,
                            inline: true
                        });
                    });

                    await message.reply({ embeds: [embed] });
                } catch (error) {
                    await message.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'list': {
                try {
                    const response = await axios.get(`${BOT_API_URL}/status`, { timeout: 10000 });
                    const { bots = [], count = 0 } = response.data;

                    if (count === 0) return message.reply('📋 No bots running');

                    let list = `**Active Bots (${count}):**\n\n`;
                    bots.forEach(bot => {
                        const status = bot.connected ? '🟢' : '🔴';
                        list += `${status} **${bot.mcUsername}** (\`${bot.username}\`)\n`;
                    });

                    await message.reply(list);
                } catch (error) {
                    await message.reply(`❌ Error: ${error.message}`);
                }
                break;
            }

            case 'help': {
                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('📖 Commands')
                    .addFields(
                        { name: '!add <token>', value: 'Start bot', inline: false },
                        { name: '!stopall', value: 'Stop all bots', inline: false },
                        { name: '!status', value: 'View status', inline: false },
                        { name: '!list', value: 'List bots', inline: false }
                    );

                await message.reply({ embeds: [embed] });
                break;
            }

            case 'forcemsg': {
                const botId = args[0];
                const target = args[1];

                if (!botId || !target) return message.reply('Usage: `!forcemsg <botid> <player>`');

                try {
                    await callBotAPI('/forcemsg', { username: botId, target: target });
                    await message.reply(`✅ Sent to **${target}**`);
                } catch (error) {
                    await message.reply(`❌ Error: ${error.message}`);
                }
                break;
            }
        }
    } catch (error) {
        console.error(error);
        await message.reply(`❌ Error: ${error.message}`);
    }
});

client.on('error', error => console.error('Discord error:', error));

client.login(DISCORD_TOKEN);
