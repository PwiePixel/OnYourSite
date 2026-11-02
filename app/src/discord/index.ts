// Feste Schnittstelle für andere Teile der Seite (z. B. Statusseiten): Webhook-Links erkennen und prüfen, mit
// Discord sprechen und dessen Fehler verständlich machen – ohne etwas, das nur Updates betrifft.
export { discordBase, discordError, discordRequest, discordSaid, walkErrors, type DiscordResponse, type Payload, type Via } from './rest.js';
export {
  checkWebhook, cleanWebhookLink, maskedWebhook, parseWebhookLink, webhookDelete, webhookEdit, webhookPost, type WebhookLink,
} from './webhook.js';
export { displayNameProblem, parseMention, snowflake } from './settings.js';
