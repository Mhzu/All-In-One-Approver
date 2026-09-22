require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });
const app = express();
app.use(express.json());

let whitelist = new Set();
let blacklist = new Set();
let tempApproved = new Set(); // one-time accepts only (clears on restart — intentional)
let dataMessage = null; // Discord message used as permanent storage

function normalize(u) {
    return String(u || '').toLowerCase().trim();
}

async function loadData() {
    try {
        const channelId = process.env.DATA_CHANNEL_ID || process.env.APPROVAL_CHANNEL_ID;
        if (!channelId) {
            console.log('No DATA_CHANNEL_ID / APPROVAL_CHANNEL_ID — whitelist will not persist');
            return;
        }
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            console.log('Data channel not found');
            return;
        }

        // Prefer a fixed message ID if provided
        if (process.env.DATA_MESSAGE_ID) {
            dataMessage = await channel.messages.fetch(process.env.DATA_MESSAGE_ID).catch(() => null);
        }

        // Otherwise find an existing storage message
        if (!dataMessage) {
            const messages = await channel.messages.fetch({ limit: 30 });
            dataMessage = messages.find(m => m.author.id === client.user.id && m.content.startsWith('HUB_DATA:')) || null;
        }

        // Create one if missing
        if (!dataMessage) {
            dataMessage = await channel.send('HUB_DATA:{"whitelist":[],"blacklist":[]}');
            console.log('Created new data message:', dataMessage.id);
            console.log('Optional: set DATA_MESSAGE_ID=' + dataMessage.id + ' in Render env');
        }

        const raw = dataMessage.content.replace(/^HUB_DATA:/, '');
        const data = JSON.parse(raw);
        whitelist = new Set((data.whitelist || []).map(normalize));
        blacklist = new Set((data.blacklist || []).map(normalize));
        console.log(`Loaded permanent lists — whitelist: ${whitelist.size}, blacklist: ${blacklist.size}`);
    } catch (e) {
        console.error('loadData failed:', e.message);
    }
}

async function saveData() {
    try {
        if (!dataMessage) {
            console.log('No data message to save to');
            return;
        }
        const payload = 'HUB_DATA:' + JSON.stringify({
            whitelist: [...whitelist],
            blacklist: [...blacklist]
        });
        // Discord message limit is 2000 chars — fine for normal lists
        dataMessage = await dataMessage.edit(payload);
        console.log(`Saved lists — whitelist: ${whitelist.size}, blacklist: ${blacklist.size}`);
    } catch (e) {
        console.error('saveData failed:', e.message);
    }
}

// ========== HTTP ==========

app.get('/check', (req, res) => {
    const user = normalize(req.query.user);
    if (!user) return res.json({ approved: false });

    if (blacklist.has(user)) return res.json({ approved: false, status: 'blacklisted' });
    if (whitelist.has(user)) return res.json({ approved: true, status: 'whitelisted' });
    if (tempApproved.has(user)) return res.json({ approved: true, status: 'temp' });
    return res.json({ approved: false, status: 'pending' });
});

app.post('/request', async (req, res) => {
    const { username, displayName, place, jobId } = req.body || {};
    if (!username) return res.status(400).json({ error: 'missing username' });

    const lower = normalize(username);

    // Permanent decisions — no DM needed
    if (blacklist.has(lower)) return res.json({ ok: true, auto: 'blacklisted' });
    if (whitelist.has(lower)) return res.json({ ok: true, auto: 'whitelisted' });

    // Already temp-approved this session
    if (tempApproved.has(lower)) return res.json({ ok: true, auto: 'temp' });

    try {
        const owner = await client.users.fetch(process.env.OWNER_ID);
        if (!owner) return res.status(500).json({ error: 'owner not found' });

        const embed = new EmbedBuilder()
            .setTitle('Hub Access Request')
            .setDescription(`**${displayName || username}** (\`${username}\`) wants to open the hub.`)
            .addFields(
                { name: 'Place', value: String(place || 'unknown'), inline: true },
                { name: 'User', value: username, inline: true },
                { name: 'Server', value: jobId ? `\`${jobId}\`` : 'n/a', inline: false }
            )
            .setColor(0xFF3333)
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`accept_${username}`).setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`deny_${username}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`whitelist_${username}`).setLabel('Whitelist').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`blacklist_${username}`).setLabel('Blacklist').setStyle(ButtonStyle.Secondary)
        );

        await owner.send({ embeds: [embed], components: [row] });
        res.json({ ok: true });
    } catch (e) {
        console.error('Failed to DM owner:', e.message);
        res.status(500).json({ error: 'failed to DM owner – enable DMs from server members' });
    }
});

// ========== INTERACTIONS ==========

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.user.id !== process.env.OWNER_ID) {
            return interaction.reply({ content: 'Only the owner can use these buttons.', ephemeral: true });
        }

        const [action, ...rest] = interaction.customId.split('_');
        const username = rest.join('_');
        const lower = normalize(username);

        if (action === 'accept') {
            // One-time only (until bot restarts)
            tempApproved.add(lower);
            await interaction.update({
                content: `✅ **Accepted** (one-time) \`${username}\`\nThey will need approval again after the bot restarts.\nUse **Whitelist** for permanent access.`,
                embeds: [],
                components: []
            });
        } else if (action === 'deny') {
            tempApproved.delete(lower);
            await interaction.update({
                content: `❌ **Denied** \`${username}\``,
                embeds: [],
                components: []
            });
        } else if (action === 'whitelist') {
            whitelist.add(lower);
            blacklist.delete(lower);
            tempApproved.add(lower);
            await saveData();
            await interaction.update({
                content: `✅ **Whitelisted** \`${username}\` (permanent until /unwhitelist)`,
                embeds: [],
                components: []
            });
        } else if (action === 'blacklist') {
            blacklist.add(lower);
            whitelist.delete(lower);
            tempApproved.delete(lower);
            await saveData();
            await interaction.update({
                content: `🚫 **Blacklisted** \`${username}\` (permanent until /unblacklist)`,
                embeds: [],
                components: []
            });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== process.env.OWNER_ID) {
        return interaction.reply({ content: 'Only the owner can use these commands.', ephemeral: true });
    }

    const cmd = interaction.commandName;
    const userOption = interaction.options.getString('username');
    const lower = userOption ? normalize(userOption) : null;

    if (cmd === 'whitelist') {
        whitelist.add(lower);
        blacklist.delete(lower);
        tempApproved.add(lower);
        await saveData();
        await interaction.reply(`✅ **${userOption}** has been **whitelisted** (permanent).`);
    } else if (cmd === 'blacklist') {
        blacklist.add(lower);
        whitelist.delete(lower);
        tempApproved.delete(lower);
        await saveData();
        await interaction.reply(`🚫 **${userOption}** has been **blacklisted** (permanent).`);
    } else if (cmd === 'unwhitelist') {
        whitelist.delete(lower);
        tempApproved.delete(lower);
        await saveData();
        await interaction.reply(`Removed **${userOption}** from the whitelist. They will need permission again.`);
    } else if (cmd === 'unblacklist') {
        blacklist.delete(lower);
        await saveData();
        await interaction.reply(`Removed **${userOption}** from the blacklist.`);
    } else if (cmd === 'list') {
        const w = [...whitelist].join(', ') || '(empty)';
        const b = [...blacklist].join(', ') || '(empty)';
        await interaction.reply({
            content: `**Whitelist (permanent):**\n${w}\n\n**Blacklist (permanent):**\n${b}`,
            ephemeral: true
        });
    }
});

// ========== SLASH COMMANDS ==========

const commands = [
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Permanently allow a user to open the hub')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder()
        .setName('blacklist')
        .setDescription('Permanently deny a user from opening the hub')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('Remove a user from the whitelist')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder()
        .setName('unblacklist')
        .setDescription('Remove a user from the blacklist')
        .addStringOption(opt => opt.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('Show current whitelist and blacklist')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Bot ready as ${client.user.tag}`);

    await loadData();

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered');
    } catch (e) {
        console.error('Failed to register commands:', e);
    }

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`HTTP server listening on port ${port}`));
});

client.login(process.env.DISCORD_TOKEN);
