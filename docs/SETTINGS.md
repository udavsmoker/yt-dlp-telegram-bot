# Settings System

Per-chat feature toggles for administrators.

## Usage

### Command
- `/settings` - Opens interactive menu (admins only)
- Only the admin who opened the menu can use the buttons
- Command message automatically deleted

### Menu Interface
```
⚙️ Settings Menu

Toggle features on/off by tapping the buttons below.
Changes are saved automatically.

[📹 Video Download - ✅ ON]
[🤖 AI Chat Responses - ❌ OFF]
[🎨 Meme Generator - ✅ ON]
[🖼️ Demotivators - ✅ ON]
[❌ Close]
```

## Current Features

- **Video Download** - Download and send videos from supported platforms
- **AI Chat Responses** - Markov chain chat participation
- **Meme Generator** - Generate memes from chat messages
- **Demotivators** - Russian-style demotivator generation

## Storage

**Location:** `data/settings.json`

**Format:**
```json
{
  "123456789": {
    "videoDownload": true,
    "markovResponses": false,
    "memeGeneration": true,
    "demotivatorsEnabled": true
  }
}
```

## Adding New Features

### 1. Add to `defaultSettings` in `settings.service.js`:
```javascript
this.defaultSettings = {
  videoDownload: true,
  myNewFeature: true
};
```

### 2. Add to `getFeatureInfo()` in `settings.service.js`:
```javascript
myNewFeature: {
  name: '✨ My Feature',
  description: 'Description of the feature'
}
```

### 3. Check in handlers:
```javascript
const settingsService = require('../services/settings.service');

if (!settingsService.isFeatureEnabled(ctx.chat.id, 'myNewFeature')) {
  return;
}
```

The settings menu will automatically show the new feature.

## Architecture

**Files:**
- `src/services/settings.service.js` - Storage and API
- `src/handlers/settings.handler.js` - UI and callback handlers

**API:**
- `isFeatureEnabled(chatId, featureName)` - Check if feature is on
- `toggleFeature(chatId, featureName)` - Toggle feature
- Settings loaded into memory on startup (Map for O(1) lookups)

**Features:**
- Per-chat isolation
- Automatic migration for new features
- Instant updates via callback queries
- Persistent storage (survives bot restarts)

