# Demotivator Generator

Russian-style demotivators generated from chat photos and messages.

## Commands

- `/demotivate` - Random photo + random message
- `/demotivate` (reply to photo) - Use specific photo
- `/photostats` - View photo database stats

## How It Works

1. Bot automatically saves all photos sent to chat (max 100 per chat)
2. User runs `/demotivate`
3. Bot selects random photo and message from database
4. Generates classic Russian demotivator style
5. Sends rendered image to chat

## Rendering

- Black background (1200x1400px)
- White border (5px) around photo
- Centered image (max 900px height, preserves aspect ratio)
- White text below (Arial 48px, bold, max 3 lines)

## Database

Photo metadata stored in SQLite:
- Telegram file_id (for downloading)
- Image dimensions, file size
- Message ID, timestamp, caption
- Maximum 100 photos per chat (FIFO cleanup)

## Settings

Enable in `/settings` (admins only):
- **🖼️ Demotivators** toggle
- When enabled: Bot learns from photos, commands available
- When disabled: No learning, commands return error

## Examples

```
User: /demotivate
Bot: 🎨 Creating demotivator...
     [Rendered demotivator image]

User: /photostats
Bot: 📊 Photo Statistics
     Total Photos: 47/100
     Storage: 47.0% full
```

## Files

- `src/services/photo-database.service.js` - Photo metadata storage
- `src/services/demotivator.service.js` - Canvas rendering
- `src/middleware/photo.middleware.js` - Auto-learning
- `src/handlers/demotivator.handler.js` - Command handlers
