require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });
const app = express();
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

let whitelist = new Set();
let blacklist = new Set();
let tempApproved = new Set();

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            whitelist = new Set((data.whitelist || []).map(u => u.toLowerCase()));
            blacklist = new Set((data.blacklist || []).map(u => u.toLowerCase()));
            console.log(`Loaded ${whitelist.size} whitelist, ${blacklist.size} blacklist`);
        }
    } catch (e) {
        console.log('No existing data file, starting fresh');
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            whitelist: [...whitelist],
            blacklist: [...blacklist]
        }, null, 2));
    } catch (e) {
        console.error('Failed to save data:', e.message);
    }
}

loadData();

// ========== HTTP ==========

app.get('/check', (req, res) => {
    const user = (req.query.user || '').toLowerCase();
    if (!user) return res.json({ approved: false });

    if (blacklist.has(user)) return res.json({ approved: false, status: 'blacklisted' });
    if (whitelist.has(user)) return res.json({ approved: true, status: 'whitelisted' });
    if (tempApproved.has(user)) return res.json({ approved: true, status: 'temp' });
    return res.json({ approved: false, status: 'pending' });
});

app.post('/request', async (req, res) => {
    const { username, displayName, place, jobId } = req.body;
    if (!username) return res.status(400).json({ error: 'missing username' });

    const lower = username.toLowerCase();

    if (blacklist.has(lower)) return res.json({ ok: true, auto: 'blacklisted' });
    if (whitelist.has(lower)) return res.json({ ok: true, auto: 'whitelisted' });

    // Send as DM to the owner (easy to dismiss)
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
        res.status(500).json({ error: 'failed to DM owner – open DMs from server members' });
    }
});

// ========== BUTTONS ==========

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.user.id !== process.env.OWNER_ID) {
            return interaction.reply({ content: 'Only the owner can use these buttons.', ephemeral: true });
        }

        const [action, ...rest] = interaction.customId.split('_');
        const username = rest.join('_');
        const lower = username.toLowerCase();

        if (action === 'accept') {
            tempApproved.add(lower);
            await interaction.update({
                content: `✅ **Accepted** (one-time) \`${username}\``,
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
            saveData();
            await interaction.update({
                content: `✅ **Whitelisted** \`${username}\` (permanent)`,
                embeds: [],
                components: []
            });
        } else if (action === 'blacklist') {
            blacklist.add(lower);
            whitelist.delete(lower);
            tempApproved.delete(lower);
            saveData();
            await interaction.update({
                content: `🚫 **Blacklisted** \`${username}\` (permanent)`,
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
    const lower = userOption ? userOption.toLowerCase() : null;

    if (cmd === 'whitelist') {
        whitelist.add(lower);
        blacklist.delete(lower);
        saveData();
        await interaction.reply(`✅ **${userOption}** has been **whitelisted**.`);
    } else if (cmd === 'blacklist') {
        blacklist.add(lower);
        whitelist.delete(lower);
        tempApproved.delete(lower);
        saveData();
        await interaction.reply(`🚫 **${userOption}** has been **blacklisted**.`);
    } else if (cmd === 'unwhitelist') {
        whitelist.delete(lower);
        saveData();
        await interaction.reply(`Removed **${userOption}** from the whitelist.`);
    } else if (cmd === 'unblacklist') {
        blacklist.delete(lower);
        saveData();
        await interaction.reply(`Removed **${userOption}** from the blacklist.`);
    } else if (cmd === 'list') {
        const w = [...whitelist].join(', ') || '(empty)';
        const b = [...blacklist].join(', ') || '(empty)';
        await interaction.reply({ content: `**Whitelist:**\n${w}\n\n**Blacklist:**\n${b}`, ephemeral: true });
    }
});

// ========== SLASH COMMANDS ==========

const commands = [
    new SlashCommandBuilder().setName('whitelist').setDescription('Permanently allow a user').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder().setName('blacklist').setDescription('Permanently deny a user').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder().setName('unwhitelist').setDescription('Remove from whitelist').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder().setName('unblacklist').setDescription('Remove from blacklist').addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),
    new SlashCommandBuilder().setName('list').setDescription('Show whitelist and blacklist')
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Bot ready as ${client.user.tag}`);

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
