const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { SettingsService } = require('../src/services/settings.service');

describe('SettingsService (SQLite)', () => {
  let service;

  beforeEach(async () => {
    service = new SettingsService(':memory:');
    await service.init();
  });

  it('should initialize with default settings for a new chat', () => {
    const settings = service.getSettings('chat_100');
    assert.deepEqual(settings, {
      videoDownload: true,
      markovResponses: false,
      memeGeneration: false,
      demotivatorsEnabled: false,
      blacklistEnabled: true,
    });
  });

  it('should verify isFeatureEnabled for default and toggled features', () => {
    assert.equal(service.isFeatureEnabled('chat_100', 'videoDownload'), true);
    assert.equal(service.isFeatureEnabled('chat_100', 'markovResponses'), false);
    assert.equal(service.isFeatureEnabled('chat_100', 'memeGeneration'), false);
    assert.equal(service.isFeatureEnabled('chat_100', 'blacklistEnabled'), true);
  });

  it('should toggle features and persist to database', async () => {
    // Toggle videoDownload from true to false
    const newVal = await service.toggleFeature('chat_100', 'videoDownload');
    assert.equal(newVal, false);
    assert.equal(service.isFeatureEnabled('chat_100', 'videoDownload'), false);

    // Toggle markovResponses from false to true
    const markovVal = await service.toggleFeature('chat_100', 'markovResponses');
    assert.equal(markovVal, true);
    assert.equal(service.isFeatureEnabled('chat_100', 'markovResponses'), true);

    // Verify row in SQLite
    const row = service.db.prepare('SELECT settings_json FROM chat_settings WHERE chat_id = ?').get('chat_100');
    assert.ok(row);
    const parsed = JSON.parse(row.settings_json);
    assert.equal(parsed.videoDownload, false);
    assert.equal(parsed.markovResponses, true);
  });

  it('should set features explicitly using setFeature', async () => {
    await service.setFeature('chat_200', 'memeGeneration', true);
    assert.equal(service.isFeatureEnabled('chat_200', 'memeGeneration'), true);

    await service.setFeature('chat_200', 'memeGeneration', false);
    assert.equal(service.isFeatureEnabled('chat_200', 'memeGeneration'), false);
  });

  it('should isolate settings between different chats', async () => {
    await service.setFeature('chat_A', 'videoDownload', false);
    await service.setFeature('chat_B', 'videoDownload', true);

    assert.equal(service.isFeatureEnabled('chat_A', 'videoDownload'), false);
    assert.equal(service.isFeatureEnabled('chat_B', 'videoDownload'), true);
  });

  it('should return feature metadata descriptions', () => {
    const features = service.getFeatureInfo();
    assert.ok(features.videoDownload);
    assert.ok(features.markovResponses);
    assert.ok(features.memeGeneration);
    assert.ok(features.demotivatorsEnabled);
    assert.ok(features.blacklistEnabled);
  });
});
