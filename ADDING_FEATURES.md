# Adding Toggleable Features

Guide for adding new features to the settings system.

## Quick Steps

### 1. Define Feature (2 minutes)

Edit `src/services/settings.service.js`:

```javascript
this.defaultSettings = {
  videoDownload: true,
  myNewFeature: true  // Add with default value
};

getFeatureInfo() {
  return {
    videoDownload: {
      name: '📹 Video Download',
      description: 'Download and send videos from supported platforms'
    },
    myNewFeature: {
      name: '✨ My Feature',
      description: 'What this feature does'
    }
  };
}
```

### 2. Use in Handlers (1 minute)

```javascript
const settingsService = require('../services/settings.service');

if (!settingsService.isFeatureEnabled(ctx.chat.id, 'myNewFeature')) {
  return;
}

// Feature logic here
```

### 3. Done

The feature automatically:
- Appears in `/settings` menu
- Saves to `data/settings.json`
- Works independently per chat
- Shows ON/OFF status
- Updates in real-time

## Examples

### Auto-Delete Messages
```javascript
// settings.service.js
this.defaultSettings = {
  autoDelete: false
};

getFeatureInfo() {
  return {
    autoDelete: {
      name: '🗑️ Auto Delete',
      description: 'Delete your message after download'
    }
  };
}

// download.handler.js
if (settingsService.isFeatureEnabled(chatId, 'autoDelete')) {
  await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
}
```

### TikTok Slideshows
```javascript
// settings.service.js
this.defaultSettings = {
  tiktokSlideshow: true
};

// download.handler.js
if (isTikTokUrl(url) && settingsService.isFeatureEnabled(chatId, 'tiktokSlideshow')) {
  // Slideshow download logic
}
```

## API

```javascript
// Check if enabled
settingsService.isFeatureEnabled(chatId, 'featureName')  // → true/false

// Get all settings
settingsService.getSettings(chatId)  // → { videoDownload: true, ... }

// Toggle feature
await settingsService.toggleFeature(chatId, 'featureName')  // → new value

// Set feature
await settingsService.setFeature(chatId, 'featureName', true)  // → true
```

## Tips

- **Naming:** Use camelCase (`myFeature`, not `my-feature`)
- **Emojis:** Add to feature name for visual appeal
- **Defaults:** Set to `true` for enabled-by-default features
- **Access:** Only admins can use `/settings`, only menu opener can use buttons

## Troubleshooting

**Feature not in menu?**
- Check `getFeatureInfo()` has the feature
- Restart bot

**Toggle not working?**
- Check feature name matches exactly (case-sensitive)
- Check logs for errors

**Settings not saving?**
- Check `data/` directory exists and is writable
- Check logs

