const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BlacklistService } = require('../src/services/blacklist.service');

describe('BlacklistService', () => {
  const tempPath = path.join(__dirname, '../temp/test_blacklist.json');
  let service;

  beforeEach(() => {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    service = new BlacklistService(tempPath);
  });

  afterEach(() => {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  });

  it('should initialize with default blacklisted user when file is missing', () => {
    assert.equal(service.isBlacklisted(1003584037), true);
    assert.equal(service.isBlacklisted(999999), false);
  });

  it('should add user to blacklist and persist to file', () => {
    const added = service.addUser(777);
    assert.equal(added, true);
    assert.equal(service.isBlacklisted(777), true);

    // Duplicate add should return false
    const duplicate = service.addUser(777);
    assert.equal(duplicate, false);

    // Check file content
    const raw = fs.readFileSync(tempPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.userIds.includes(777));
  });

  it('should remove user from blacklist', () => {
    service.addUser(888);
    assert.equal(service.isBlacklisted(888), true);

    const removed = service.removeUser(888);
    assert.equal(removed, true);
    assert.equal(service.isBlacklisted(888), false);

    const notFound = service.removeUser(888);
    assert.equal(notFound, false);
  });

  it('should return a random offensive response from collection', () => {
    const response = service.getRandomResponse();
    assert.ok(typeof response === 'string' && response.length > 0);
    assert.ok(service.responses.includes(response));
  });

  it('should return accurate blacklist count and list copy', () => {
    const list = service.getBlacklistedUsers();
    assert.ok(Array.isArray(list));
    assert.equal(service.getBlacklistCount(), list.length);
  });
});
