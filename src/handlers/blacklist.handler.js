const blacklistService = require('../services/blacklist.service');
const { getUserInfo } = require('../utils/helpers');
const logger = require('../utils/logger');

const ADMIN_ID = 440493817;

// Helper to safely get user info
function safeGetUserInfo(user) {
  if (!user) return 'Unknown user';
  try {
    return getUserInfo(user);
  } catch (error) {
    return `User ${user.id || 'unknown'}`;
  }
}

// Helper to check if user is admin
function isAdmin(userId) {
  return userId === ADMIN_ID;
}

// /blacklist add <userId>
async function addToBlacklist(ctx) {
  try {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
      await ctx.reply('⛔️ Only bot admin can manage the blacklist.');
      logger.warn(`Unauthorized blacklist access attempt by ${safeGetUserInfo(ctx.from)}`);
      return;
    }

    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
      await ctx.reply('Usage: /blacklist add <userId>');
      return;
    }

    const targetUserId = parseInt(args[2]);
    if (isNaN(targetUserId)) {
      await ctx.reply('❌ Invalid user ID. Must be a number.');
      return;
    }

    if (targetUserId === ADMIN_ID) {
      await ctx.reply('😏 Nice try, but you can\'t blacklist yourself.');
      return;
    }

    const added = blacklistService.addUser(targetUserId);
    if (added) {
      await ctx.reply(`✅ User ${targetUserId} added to blacklist.`);
      logger.info(`${safeGetUserInfo(ctx.from)} added ${targetUserId} to blacklist`);
    } else {
      await ctx.reply(`ℹ️ User ${targetUserId} is already blacklisted.`);
    }
  } catch (error) {
    logger.error('Error adding to blacklist:', error);
    await ctx.reply('❌ Failed to add user to blacklist.');
  }
}

// /blacklist remove <userId>
async function removeFromBlacklist(ctx) {
  try {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
      await ctx.reply('⛔️ Only bot admin can manage the blacklist.');
      logger.warn(`Unauthorized blacklist access attempt by ${safeGetUserInfo(ctx.from)}`);
      return;
    }

    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
      await ctx.reply('Usage: /blacklist remove <userId>');
      return;
    }

    const targetUserId = parseInt(args[2]);
    if (isNaN(targetUserId)) {
      await ctx.reply('❌ Invalid user ID. Must be a number.');
      return;
    }

    const removed = blacklistService.removeUser(targetUserId);
    if (removed) {
      await ctx.reply(`✅ User ${targetUserId} removed from blacklist.`);
      logger.info(`${safeGetUserInfo(ctx.from)} removed ${targetUserId} from blacklist`);
    } else {
      await ctx.reply(`ℹ️ User ${targetUserId} was not in the blacklist.`);
    }
  } catch (error) {
    logger.error('Error removing from blacklist:', error);
    await ctx.reply('❌ Failed to remove user from blacklist.');
  }
}

// /blacklist list
async function listBlacklist(ctx) {
  try {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
      await ctx.reply('⛔️ Only bot admin can view the blacklist.');
      logger.warn(`Unauthorized blacklist access attempt by ${safeGetUserInfo(ctx.from)}`);
      return;
    }

    const blacklisted = blacklistService.getBlacklistedUsers();
    
    if (blacklisted.length === 0) {
      await ctx.reply('📋 Blacklist is empty.');
      return;
    }

    const list = blacklisted.map((id, index) => `${index + 1}. ${id}`).join('\n');
    await ctx.reply(`📋 *Blacklisted Users (${blacklisted.length}):*\n\n${list}`, {
      parse_mode: 'Markdown'
    });
    
    logger.info(`${safeGetUserInfo(ctx.from)} viewed blacklist`);
  } catch (error) {
    logger.error('Error listing blacklist:', error);
    await ctx.reply('❌ Failed to retrieve blacklist.');
  }
}

// Main /blacklist command handler
async function handleBlacklist(ctx) {
  try {
    const userId = ctx.from.id;
    
    if (!isAdmin(userId)) {
      await ctx.reply('⛔️ Only bot admin can manage the blacklist.');
      logger.warn(`Unauthorized blacklist access attempt by ${safeGetUserInfo(ctx.from)}`);
      return;
    }

    const args = ctx.message.text.split(' ');
    
    if (args.length < 2) {
      const count = blacklistService.getBlacklistCount();
      await ctx.reply(
        `🚫 *Blacklist Management*\n\n` +
        `Currently blacklisted: ${count} user(s)\n\n` +
        `*Commands:*\n` +
        `/blacklist list - View all blacklisted users\n` +
        `/blacklist add <userId> - Add user to blacklist\n` +
        `/blacklist remove <userId> - Remove user from blacklist`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const subcommand = args[1].toLowerCase();
    
    switch (subcommand) {
      case 'add':
        await addToBlacklist(ctx);
        break;
      case 'remove':
        await removeFromBlacklist(ctx);
        break;
      case 'list':
        await listBlacklist(ctx);
        break;
      default:
        await ctx.reply('❌ Unknown subcommand. Use: add, remove, or list');
    }
  } catch (error) {
    logger.error('Error in blacklist handler:', error);
    await ctx.reply('❌ An error occurred while processing the command.');
  }
}

module.exports = {
  handleBlacklist,
  isAdmin,
  ADMIN_ID
};
