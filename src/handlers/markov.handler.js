const markovDb = require('../services/markov-database.service');
const settingsService = require('../services/settings.service');
const logger = require('../utils/logger');

// Helper to check if user is admin
async function isAdmin(ctx) {
  try {
    const chatType = ctx.chat.type;
    
    // In private chats, user is always admin
    if (chatType === 'private') {
      return true;
    }
    
    // In groups/supergroups, check if user is creator or administrator
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === 'creator' || member.status === 'administrator';
  } catch (error) {
    logger.error(`Error checking admin status: ${error.message}`);
    return false;
  }
}

// Helper to validate and clamp value 0-100
function clampValue(value, min = 0, max = 100) {
  const num = parseInt(value);
  if (isNaN(num)) return null;
  return Math.max(min, Math.min(max, num));
}

// /setlaziness command
async function handleSetLaziness(ctx) {
  try {
    // Check if markov feature is enabled
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'markovResponses');
    if (!isEnabled) {
      return ctx.reply('❌ Markov responses are disabled. Enable them in /settings first.');
    }

    // Check admin
    if (!await isAdmin(ctx)) {
      return ctx.reply('❌ Only administrators can change personality settings.');
    }

    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      const settings = markovDb.getPersonalitySettings(ctx.chat.id);
      return ctx.reply(
        `Current laziness: ${settings.laziness}/100\n\n` +
        `Usage: /setlaziness <0-100>\n` +
        `Lower = responds more often\n` +
        `Higher = responds less often`
      );
    }

    const value = clampValue(args[0]);
    if (value === null) {
      return ctx.reply('❌ Invalid value. Use a number between 0 and 100.');
    }

    markovDb.updatePersonalitySetting(ctx.chat.id, 'laziness', value);
    
    let description = '';
    if (value <= 25) description = ' (Very active 🔥)';
    else if (value <= 50) description = ' (Balanced ⚖️)';
    else if (value <= 75) description = ' (Lazy 😴)';
    else description = ' (Very lazy 💤)';

    await ctx.reply(`✅ Laziness set to ${value}/100${description}`);
    logger.info(`Laziness set to ${value} for chat ${ctx.chat.id}`);
  } catch (error) {
    logger.error(`Error in setlaziness handler: ${error.message}`);
    await ctx.reply('❌ Error updating laziness setting.');
  }
}

// /setcoherence command
async function handleSetCoherence(ctx) {
  try {
    // Check if markov feature is enabled
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'markovResponses');
    if (!isEnabled) {
      return ctx.reply('❌ Markov responses are disabled. Enable them in /settings first.');
    }

    // Check admin
    if (!await isAdmin(ctx)) {
      return ctx.reply('❌ Only administrators can change personality settings.');
    }

    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      const settings = markovDb.getPersonalitySettings(ctx.chat.id);
      return ctx.reply(
        `Current coherence: ${settings.coherence}/100\n\n` +
        `Usage: /setcoherence <0-100>\n` +
        `0 = Random saved messages\n` +
        `50 = Mix of random and AI-generated\n` +
        `100 = Only AI-generated responses`
      );
    }

    const value = clampValue(args[0]);
    if (value === null) {
      return ctx.reply('❌ Invalid value. Use a number between 0 and 100.');
    }

    markovDb.updatePersonalitySetting(ctx.chat.id, 'coherence', value);
    
    let description = '';
    if (value <= 33) description = ' (Random messages 🎲)';
    else if (value <= 66) description = ' (Mixed 🔀)';
    else description = ' (AI-generated 🤖)';

    await ctx.reply(`✅ Coherence set to ${value}/100${description}`);
    logger.info(`Coherence set to ${value} for chat ${ctx.chat.id}`);
  } catch (error) {
    logger.error(`Error in setcoherence handler: ${error.message}`);
    await ctx.reply('❌ Error updating coherence setting.');
  }
}

// /setsassiness command
async function handleSetSassiness(ctx) {
  try {
    // Check if markov feature is enabled
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'markovResponses');
    if (!isEnabled) {
      return ctx.reply('❌ Markov responses are disabled. Enable them in /settings first.');
    }

    // Check admin
    if (!await isAdmin(ctx)) {
      return ctx.reply('❌ Only administrators can change personality settings.');
    }

    const args = ctx.message.text.split(' ').slice(1);
    
    if (args.length === 0) {
      const settings = markovDb.getPersonalitySettings(ctx.chat.id);
      return ctx.reply(
        `Current sassiness: ${settings.sassiness}/100\n\n` +
        `Usage: /setsassiness <0-100>\n` +
        `Lower = Calm and neutral\n` +
        `Higher = More emotional and expressive!`
      );
    }

    const value = clampValue(args[0]);
    if (value === null) {
      return ctx.reply('❌ Invalid value. Use a number between 0 and 100.');
    }

    markovDb.updatePersonalitySetting(ctx.chat.id, 'sassiness', value);
    
    let description = '';
    if (value <= 25) description = ' (Calm 😐)';
    else if (value <= 50) description = ' (Neutral 🙂)';
    else if (value <= 75) description = ' (Sassy 😏)';
    else description = ' (Very sassy! 🔥)';

    await ctx.reply(`✅ Sassiness set to ${value}/100${description}`);
    logger.info(`Sassiness set to ${value} for chat ${ctx.chat.id}`);
  } catch (error) {
    logger.error(`Error in setsassiness handler: ${error.message}`);
    await ctx.reply('❌ Error updating sassiness setting.');
  }
}

// /botstats command
async function handleBotStats(ctx) {
  try {
    // Check if markov feature is enabled
    const isEnabled = await settingsService.isFeatureEnabled(ctx.chat.id, 'markovResponses');
    if (!isEnabled) {
      return ctx.reply('❌ Markov responses are disabled. Enable them in /settings first.');
    }

    const chatId = ctx.chat.id;
    const messageCount = markovDb.getMessageCount(chatId);
    const settings = markovDb.getPersonalitySettings(chatId);
    
  // Calculate base trigger chance (linear mapping)
  const baseTriggerChance = (100 - settings.laziness) / 100; // 0..1
  const triggerPercentage = (baseTriggerChance * 100).toFixed(1);

    const stats = `📊 **Bot Statistics**

💬 **Messages learned:** ${messageCount.toLocaleString()}/50,000
${messageCount < 20 ? '⚠️ Need at least 20 messages to start responding\n' : ''}
⚙️ **Personality Settings:**
• Laziness: ${settings.laziness}/100 (${triggerPercentage}% base chance)
• Coherence: ${settings.coherence}/100
• Sassiness: ${settings.sassiness}/100
• Markov Order: ${settings.markov_order}
• Silence Trigger: ${settings.silence_minutes} minutes

💡 **Tip:** Higher laziness = responds less often
Use /setlaziness, /setcoherence, /setsassiness to adjust`;

    await ctx.reply(stats, { parse_mode: 'Markdown' });
    logger.info(`Stats requested for chat ${chatId}`);
  } catch (error) {
    logger.error(`Error in botstats handler: ${error.message}`);
    await ctx.reply('❌ Error retrieving bot statistics.');
  }
}

module.exports = {
  handleSetLaziness,
  handleSetCoherence,
  handleSetSassiness,
  handleBotStats
};
