// index.js (Railway-friendly, multi-server, safer persistence path)
// - Works with Railway env vars (DISCORD_TOKEN)
// - Still supports local .env via dotenv (optional)
// - Uses a writable DATA_DIR if provided (e.g., Railway Volume mount), otherwise local ./data
// - Guards against missing data directory / file
// - Keeps your existing behavior: per-guild role maps + /rr-setup + /rolespanel + button toggles

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  PermissionsBitField,
} = require("discord.js");

// ---- Basic env validation ----
if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN. Set it in Railway Variables or a local .env file.");
  process.exit(1);
}

// ---- Discord client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ---- Data path (Railway-friendly) ----
// If you later add a Railway Volume, set DATA_DIR to that mount path (e.g., /data).
// If not set, it defaults to ./data inside the project (note: may reset on redeploy).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");

const DATA_PATH = path.join(DATA_DIR, "role-maps.json");

// ---------- Helpers: ensure dir, load/save ----------
function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("Failed to ensure DATA_DIR:", DATA_DIR, e);
  }
}

function loadMaps() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_PATH)) return {};
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (e) {
    console.error("Failed to load role maps:", e);
    return {};
  }
}

function saveMaps(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error(
      "Failed to save role maps. If you're on Railway, consider using a Volume (DATA_DIR) or Postgres.",
      e
    );
  }
}

let ROLE_MAPS = loadMaps();

// ---------- Slash Commands ----------
const COMMANDS = [
  {
    name: "rolespanel",
    description: "Post the reaction role panel",
  },
  {
    name: "rr-setup",
    description: "Map a button to a role (requires Manage Roles)",
    options: [
      {
        name: "button_id",
        description: "Button ID (example: rr_raider)",
        type: 3, // STRING
        required: true,
      },
      {
        name: "role",
        description: "Role to toggle",
        type: 8, // ROLE
        required: true,
      },
    ],
  },
];

// Buttons shown on the panel (you can add more)
const BUTTONS = [
  { id: "rr_raider", label: "Raider", style: ButtonStyle.Primary },
  { id: "rr_farmer", label: "Farmer", style: ButtonStyle.Success },
  { id: "rr_trader", label: "Trader", style: ButtonStyle.Secondary },
];

// ---------- Ready ----------
client.once(Events.ClientReady, async () => {
  try {
    console.log(`Logged in as ${client.user.tag}`);

    // Global commands (multi-server). Note: can take time to propagate.
    await client.application.commands.set(COMMANDS);

    console.log("Global commands registered");

    // Helpful info for debugging persistence
    console.log("ROLE_MAPS file:", DATA_PATH);
  } catch (err) {
    console.error("Error during ready:", err);
  }
});

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    const guildId = interaction.guildId;

    // ---- Setup Command ----
    if (interaction.isChatInputCommand() && interaction.commandName === "rr-setup") {
      // Permission check
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: "You need **Manage Roles**.", ephemeral: true });
      }

      const buttonId = interaction.options.getString("button_id", true);
      const role = interaction.options.getRole("role", true);

      // Basic sanity: only allow button IDs we actually render
      const validButton = BUTTONS.some((b) => b.id === buttonId);
      if (!validButton) {
        return interaction.reply({
          content: `Unknown button_id **${buttonId}**. Valid IDs: ${BUTTONS.map((b) => `\`${b.id}\``).join(", ")}`,
          ephemeral: true,
        });
      }

      ROLE_MAPS[guildId] ??= {};
      ROLE_MAPS[guildId][buttonId] = role.id;
      saveMaps(ROLE_MAPS);

      return interaction.reply({
        content: `Mapped **${buttonId}** → ${role.name}`,
        ephemeral: true,
      });
    }

    // ---- Post Panel ----
    if (interaction.isChatInputCommand() && interaction.commandName === "rolespanel") {
      const row = new ActionRowBuilder().addComponents(
        ...BUTTONS.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.style))
      );

      return interaction.reply({
        content: "Pick your roles:",
        components: [row],
      });
    }

    // ---- Button Toggle ----
    if (interaction.isButton()) {
      const roleId = ROLE_MAPS[guildId]?.[interaction.customId];
      if (!roleId) {
        return interaction.reply({ content: "This button is not configured. Use `/rr-setup` first.", ephemeral: true });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);

      // Optional: Guard if the bot can't manage this role
      // (Discord won't allow changes if bot role is below the target role.)
      const targetRole = interaction.guild.roles.cache.get(roleId);
      if (!targetRole) {
        return interaction.reply({ content: "Mapped role no longer exists. Re-run `/rr-setup`.", ephemeral: true });
      }

      const botMember = interaction.guild.members.me;
      if (!botMember) {
        return interaction.reply({ content: "Bot member not found in guild.", ephemeral: true });
      }

      // Check Manage Roles permission
      if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: "I need **Manage Roles** permission to do that.", ephemeral: true });
      }

      // Check role hierarchy
      const botTopRole = botMember.roles.highest;
      if (botTopRole.comparePositionTo(targetRole) <= 0) {
        return interaction.reply({
          content: `I can't manage **${targetRole.name}**. Move my bot role above it in **Server Settings → Roles**.`,
          ephemeral: true,
        });
      }

      const hasRole = member.roles.cache.has(roleId);

      if (hasRole) {
        await member.roles.remove(roleId);
        await interaction.reply({ content: "Role removed.", ephemeral: true });
      } else {
        await member.roles.add(roleId);
        await interaction.reply({ content: "Role added.", ephemeral: true });
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);

    // Try to tell the user *something* if possible
    try {
      if (interaction.isRepliable() && !interaction.replied) {
        await interaction.reply({ content: "Something went wrong. Check bot logs.", ephemeral: true });
      }
    } catch (_) {}
  }
});

// ---- Login ----
client.login(process.env.DISCORD_TOKEN);
