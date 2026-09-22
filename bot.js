require("dotenv").config();

const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");
const express = require("express");
const { Pool } = require("pg");

for (const name of ["DISCORD_TOKEN", "OWNER_ID", "APPROVAL_CHANNEL_ID", "DATABASE_URL"]) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS approved_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function isApproved(userId) {
  const r = await pool.query(
    "SELECT 1 FROM approved_users WHERE user_id = $1 LIMIT 1",
    [String(userId)]
  );
  return r.rowCount > 0;
}

async function approveUser(userId, username) {
  await pool.query(
    `INSERT INTO approved_users (user_id, username)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET username = EXCLUDED.username`,
    [String(userId), String(username || "unknown")]
  );
}

async function denyUser(userId) {
  await pool.query(
    "DELETE FROM approved_users WHERE user_id = $1",
    [String(userId)]
  );
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/check", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ approved: false });
    res.json({ approved: await isApproved(userId) });
  } catch (err) {
    console.error("check error:", err);
    res.status(500).json({ approved: false });
  }
});

app.post("/request", async (req, res) => {
  try {
    const { username, userId, displayName, place, jobId, placeId } = req.body;

    if (!username || !userId) {
      return res.status(400).json({ error: "missing username or userId" });
    }

    // Already-approved users skip the Discord approval step.
    if (await isApproved(userId)) {
      return res.json({ ok: true, approved: true });
    }

    const channel = await client.channels
      .fetch(process.env.APPROVAL_CHANNEL_ID)
      .catch(() => null);

    if (!channel) return res.status(500).json({ error: "channel not found" });

    const embed = new EmbedBuilder()
      .setTitle("Hub Access Request")
      .setDescription(`**${displayName || username}** (\`${username}\`) wants to open the hub.`)
      .addFields(
        { name: "Roblox User", value: String(username), inline: true },
        { name: "UserId", value: String(userId), inline: true },
        { name: "Place", value: String(place || "unknown"), inline: true },
        { name: "Place ID", value: String(placeId || "unknown"), inline: true },
        { name: "Server", value: jobId ? `\`${jobId}\`` : "n/a", inline: false }
      )
      .setColor(0xff3333)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`accept:${userId}:${username}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny:${userId}:${username}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
    res.json({ ok: true, approved: false });
  } catch (err) {
    console.error("request error:", err);
    res.status(500).json({ error: "request failed" });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.user.id !== process.env.OWNER_ID) {
    return interaction.reply({
      content: "Only the owner can accept/deny.",
      ephemeral: true
    });
  }

  const [action, userId, ...nameParts] = interaction.customId.split(":");
  const username = nameParts.join(":") || "unknown";

  try {
    if (action === "accept") {
      await approveUser(userId, username);
      await interaction.update({
        content: `✅ **Accepted permanently** \`${username}\` (UserId: ${userId})`,
        embeds: interaction.message.embeds,
        components: []
      });
    } else if (action === "deny") {
      await denyUser(userId);
      await interaction.update({
        content: `❌ **Denied** \`${username}\` (UserId: ${userId})`,
        embeds: interaction.message.embeds,
        components: []
      });
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Database error while updating the whitelist.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

async function start() {
  await initDb();

  const port = Number(process.env.PORT || 10000);
  app.listen(port, "0.0.0.0", () => {
    console.log(`HTTP server listening on ${port}`);
  });

  await client.login(process.env.DISCORD_TOKEN);
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
