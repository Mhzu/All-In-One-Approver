require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json());

const approved = new Set();

app.get('/check', (req, res) => {
    const user = (req.query.user || '').toLowerCase();
    res.json({ approved: approved.has(user) });
});

app.post('/request', async (req, res) => {
    const { username, displayName, place, jobId } = req.body;
    if (!username) return res.status(400).json({ error: 'missing username' });

    const channel = await client.channels.fetch(process.env.APPROVAL_CHANNEL_ID).catch(() => null);
    if (!channel) return res.status(500).json({ error: 'channel not found' });

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
        new ButtonBuilder().setCustomId(`deny_${username}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
    res.json({ ok: true });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== process.env.OWNER_ID) {
        return interaction.reply({ content: 'Only the owner can accept/deny.', ephemeral: true });
    }

    const [action, username] = interaction.customId.split('_');
    const lower = username.toLowerCase();

    if (action === 'accept') {
        approved.add(lower);
        await interaction.update({
            content: `✅ **Accepted** \`${username}\``,
            embeds: interaction.message.embeds,
            components: []
        });
    } else if (action === 'deny') {
        approved.delete(lower);
        await interaction.update({
            content: `❌ **Denied** \`${username}\``,
            embeds: interaction.message.embeds,
            components: []
        });
    }
});

client.once('ready', () => {
    console.log(`Bot ready as ${client.user.tag}`);
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`HTTP server listening on port ${port}`));
});

client.login(process.env.DISCORD_TOKEN);