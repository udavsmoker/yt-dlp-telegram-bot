const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const markovService = require('../src/services/markov.service');

describe('MarkovService', () => {
  describe('determineResponseType', () => {
    it('should return random when coherence is low (<= 33)', () => {
      assert.equal(markovService.determineResponseType(0), 'random');
      assert.equal(markovService.determineResponseType(20), 'random');
      assert.equal(markovService.determineResponseType(33), 'random');
    });

    it('should return markov when coherence is high (>= 67)', () => {
      assert.equal(markovService.determineResponseType(67), 'markov');
      assert.equal(markovService.determineResponseType(85), 'markov');
      assert.equal(markovService.determineResponseType(100), 'markov');
    });

    it('should return mixed when coherence is medium (34-66)', () => {
      assert.equal(markovService.determineResponseType(34), 'mixed');
      assert.equal(markovService.determineResponseType(50), 'mixed');
      assert.equal(markovService.determineResponseType(66), 'mixed');
    });
  });

  describe('shouldRespond checks', () => {
    it('should never respond to the bot itself', () => {
      const should = markovService.shouldRespond(12345, 'Hello world', 999, 999);
      assert.equal(should, false);
    });

    it('should never respond when laziness is set to 100', () => {
      const chatId = 999998;
      const markovDb = require('../src/services/markov-database.service');
      markovDb.updatePersonalitySetting(chatId, 'laziness', 100);

      const should = markovService.shouldRespond(chatId, 'Regular message', 111, 999);
      assert.equal(should, false);
    });
  });

  describe('markovCache', () => {
    it('should cache and evict models appropriately', () => {
      const chatId = 99999;
      const fakeModel = { corpus: 'test' };

      markovService.markovCache.set(chatId, {
        model: fakeModel,
        timestamp: Date.now()
      });

      assert.ok(markovService.markovCache.has(chatId));
      assert.equal(markovService.markovCache.get(chatId).model, fakeModel);
    });
  });
});
