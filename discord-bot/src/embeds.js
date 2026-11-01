'use strict';
// Einheitliche Embeds: Markenfarbe, kurzer Footer, keine Emojis.
const { EmbedBuilder } = require('discord.js');

const COLORS = { brand: 0x6366f1, green: 0x22c55e, red: 0xef4444, gray: 0x71717a, amber: 0xf59e0b };

function embed(color = COLORS.brand) {
  return new EmbedBuilder().setColor(color).setFooter({ text: 'OnYourSite' });
}

// Kurze Rückmeldung (z. B. nur für den Klickenden sichtbar)
function notice(text, color = COLORS.brand) {
  return embed(color).setDescription(text);
}

function clip(text, max) {
  text = String(text == null ? '' : text);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

module.exports = { COLORS, embed, notice, clip };
