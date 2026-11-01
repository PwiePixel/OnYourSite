'use strict';
// Wer gehört zum Team? Die Team-Rolle oder „Server verwalten“.
const { PermissionFlagsBits } = require('discord.js');

function isTeam(member, cfg) {
  if (!member) return false;
  const roles = member.roles && member.roles.cache ? member.roles.cache : null;
  if (roles && roles.has(cfg.teamRoleId)) return true;
  return Boolean(member.permissions && typeof member.permissions.has === 'function' && member.permissions.has(PermissionFlagsBits.ManageGuild));
}

module.exports = { isTeam };
