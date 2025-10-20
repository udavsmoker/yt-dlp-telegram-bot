const Markov = require('markov-strings').default;
const markovDb = require('./markov-database.service');
const logger = require('../utils/logger');

class MarkovService {
  constructor() {
    this.markovCache = new Map(); // Cache Markov models per chat
    this.cacheExpiry = 10 * 60 * 1000; // 10 minutes
    this.lastBotMessageTime = new Map(); // Track last bot message per chat
  }

  // Generate response based on personality settings
  async generateResponse(chatId, inputText = '', botUserId = null) {
    try {
      const settings = markovDb.getPersonalitySettings(chatId);
      const messageCount = markovDb.getMessageCount(chatId);

      // Need at least 20 messages to generate anything useful
      if (messageCount < 20) {
        logger.info(`Not enough messages in chat ${chatId} (${messageCount}/20)`);
        return null;
      }

      // Decide response type based on coherence setting
      const responseType = this.determineResponseType(settings.coherence);

      let response = null;

      if (responseType === 'random') {
        response = this.getRandomResponse(chatId, settings);
      } else if (responseType === 'markov') {
        response = await this.getMarkovResponse(chatId, inputText, settings);
      } else if (responseType === 'mixed') {
        // 50/50 chance between random and Markov
        if (Math.random() < 0.5) {
          response = this.getRandomResponse(chatId, settings);
        } else {
          response = await this.getMarkovResponse(chatId, inputText, settings);
        }
      }

      // Filter out bot's own responses if we have the bot user ID
      if (response && botUserId && response.includes(`@${botUserId}`)) {
        logger.info('Filtered out bot\'s own message');
        return null;
      }

      return response;
    } catch (error) {
      logger.error(`Error generating response: ${error.message}`);
      return null;
    }
  }

  // Determine response type based on coherence setting
  determineResponseType(coherence) {
    if (coherence <= 33) return 'random';
    if (coherence >= 67) return 'markov';
    return 'mixed';
  }

  // Get random message (with sassiness bias)
  getRandomResponse(chatId, settings) {
    try {
      // Higher sassiness = prefer messages with punctuation
      if (settings.sassiness > 50 && Math.random() < (settings.sassiness / 100)) {
        const sassyMessages = markovDb.getSassyMessages(chatId, 100);
        if (sassyMessages.length > 0) {
          return sassyMessages[Math.floor(Math.random() * sassyMessages.length)];
        }
      }

      // Fallback to any random message
      return markovDb.getRandomMessage(chatId);
    } catch (error) {
      logger.error(`Error getting random response: ${error.message}`);
      return null;
    }
  }

  // Generate Markov chain response
  async getMarkovResponse(chatId, inputText, settings) {
    try {
      // Get or build Markov model
      const markov = await this.getMarkovModel(chatId, settings);
      
      if (!markov) {
        logger.warn(`No Markov model available for chat ${chatId}`);
        return this.getRandomResponse(chatId, settings);
      }

      // Try to generate with context if input text provided
      let result = null;
      
      if (inputText && inputText.length > 3) {
        try {
          // Find similar messages for context
          const similarMessages = markovDb.findSimilarMessages(chatId, inputText, 50);
          
          if (similarMessages.length > 5) {
            // Build temporary model with similar messages for better context
            const contextMarkov = new Markov({
              stateSize: settings.markov_order,
              maxTries: 50
            });
            
            contextMarkov.addData(similarMessages);
            
            try {
              contextMarkov.buildCorpus();
              const generated = contextMarkov.generate({
                maxTries: 50,
                filter: (result) => {
                  return result.string.split(' ').length >= 3 && result.string.length <= 200;
                }
              });
              
              if (generated && generated.string) {
                result = generated.string;
              }
            } catch (err) {
              logger.debug(`Context-based generation failed: ${err.message}`);
            }
          }
        } catch (err) {
          logger.debug(`Error with context matching: ${err.message}`);
        }
      }

      // Fallback to general Markov generation
      if (!result) {
        const generated = markov.generate({
          maxTries: 100,
          filter: (result) => {
            // Filter: reasonable length, not too short
            return result.string.split(' ').length >= 3 && result.string.length <= 200;
          }
        });

        if (generated && generated.string) {
          result = generated.string;
        }
      }

      // Apply sassiness boost - add punctuation if setting is high
      if (result && settings.sassiness > 70 && Math.random() < 0.3) {
        const punctuation = ['!', '?', '!!', '?!', '...'];
        if (!result.match(/[!?.]{1,3}$/)) {
          result += punctuation[Math.floor(Math.random() * punctuation.length)];
        }
      }

      return result;
    } catch (error) {
      logger.error(`Error generating Markov response: ${error.message}`);
      return this.getRandomResponse(chatId, settings);
    }
  }

  // Get or build Markov model for chat
  async getMarkovModel(chatId, settings) {
    try {
      // Check cache
      const cached = this.markovCache.get(chatId);
      if (cached && (Date.now() - cached.timestamp < this.cacheExpiry)) {
        return cached.model;
      }

      // Build new model
      const messages = markovDb.getMessagesForTraining(chatId, 10000);
      
      if (messages.length < 20) {
        logger.warn(`Not enough messages to build Markov model for chat ${chatId}`);
        return null;
      }

      // Clean and validate messages
      const cleanMessages = messages.filter(m => typeof m === 'string' && m && m.trim().length > 0);
      if (cleanMessages.length < 20) {
        logger.warn(`Not enough valid messages to build Markov model for chat ${chatId} after filtering (${cleanMessages.length}/20)`);
        return null;
      }

      let markov = new Markov({
        stateSize: settings.markov_order,
        maxTries: 50
      });

      // Try building corpus using plain strings first
      try {
        markov.addData(cleanMessages);
        markov.buildCorpus();
      } catch (err) {
        logger.warn(`Failed to build Markov corpus with string data: ${err && err.message ? err.message : err}`);
        // Fallback: try using object format { string: ... } which some datasets require
        try {
          const objData = cleanMessages.map(s => ({ string: s }));
          const alt = new Markov({ stateSize: settings.markov_order, maxTries: 50 });
          alt.addData(objData);
          alt.buildCorpus();
          markov = alt;
        } catch (err2) {
          logger.error(`Failed to build Markov corpus with object data: ${err2 && err2.message ? err2.message : err2}`);
          return null;
        }
      }

      // Cache the model
      this.markovCache.set(chatId, {
        model: markov,
        timestamp: Date.now()
      });

      logger.info(`Built Markov model for chat ${chatId} with ${cleanMessages.length} messages`);
      return markov;
    } catch (error) {
      logger.error(`Error getting Markov model: ${error.message}`);
      return null;
    }
  }

  // Check if bot should respond based on triggers
  shouldRespond(chatId, messageText, fromUserId, botUserId) {
    try {
      const settings = markovDb.getPersonalitySettings(chatId);
      
      // Don't respond to bot's own messages
      if (fromUserId === botUserId) {
        return false;
      }

      // Don't respond if last message in chat was from bot (prevents back-to-back spam)
      const lastBotMessage = this.lastBotMessageTime.get(chatId);
      const lastMessageTime = markovDb.getLastMessageTime(chatId);
      
      if (lastBotMessage && lastMessageTime && lastBotMessage >= lastMessageTime) {
        logger.debug(`Last message was from bot, skipping response for chat ${chatId}`);
        return false;
      }

  // Calculate base trigger chance from laziness
  // New formula: linear mapping where laziness 0 -> 100% base chance, laziness 100 -> 0%
  // baseTriggerChance is in range [0, 1]
  const baseTriggerChance = (100 - settings.laziness) / 100;

      let triggerChance = baseTriggerChance;

      // Boost for question marks (2x chance)
      if (messageText.includes('?')) {
        triggerChance *= 2;
        logger.debug(`Question mark detected, boosting chance to ${triggerChance}`);
      }

      // Boost for keyword match (1.5x chance)
      const frequentWords = markovDb.getFrequentWords(chatId, 100);
      const messageWords = messageText.toLowerCase().match(/[а-яёa-z]{3,}/g) || [];
      const hasKeyword = messageWords.some(word => frequentWords.includes(word));
      
      if (hasKeyword) {
        triggerChance *= 1.5;
        logger.debug(`Keyword match detected, boosting chance to ${triggerChance}`);
      }

      // Check silence (if enabled) - only if there are previous messages
      if (lastMessageTime > 0) {
        const silenceMinutes = (Date.now() - lastMessageTime) / 60000;
        
        if (silenceMinutes >= settings.silence_minutes) {
          triggerChance *= 3; // 3x chance after silence
          logger.debug(`Silence detected (${silenceMinutes.toFixed(1)}min), boosting chance to ${triggerChance}`);
        }
      }

      // Cap at 90% to keep it random
      triggerChance = Math.min(triggerChance, 0.9);

      // Random roll
      const shouldTrigger = Math.random() < triggerChance;
      
      if (shouldTrigger) {
        this.lastBotMessageTime.set(chatId, Date.now());
        logger.info(`Bot will respond to chat ${chatId} (chance: ${(triggerChance * 100).toFixed(1)}%)`);
      }

      return shouldTrigger;
    } catch (error) {
      logger.error(`Error checking if should respond: ${error.message}`);
      return false;
    }
  }

  // Reset cooldown (for testing)
  resetCooldown(chatId) {
    this.lastBotMessageTime.delete(chatId);
  }

  // Clear cache
  clearCache(chatId = null) {
    if (chatId) {
      this.markovCache.delete(chatId);
    } else {
      this.markovCache.clear();
    }
  }
}

module.exports = new MarkovService();
