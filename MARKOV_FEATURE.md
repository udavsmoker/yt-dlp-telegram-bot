# AI Chat Responses (Markov Chains)

Bot learns from chat messages and randomly participates in conversations using Markov chains.

## Setup

1. Enable in `/settings` (admins only)
2. Wait for 20+ messages to be learned
3. Bot starts responding automatically

## Commands

### `/setlaziness <0-100>`
Controls response frequency:
- **0-25**: Very active (10-15% of messages)
- **26-50**: Balanced (5-10%)
- **51-75**: Lazy (2-5%)
- **76-100**: Very lazy (rarely responds)

### `/setcoherence <0-100>`
Controls response type:
- **0-33**: Random saved messages
- **34-66**: Mix of random and AI-generated
- **67-100**: Pure Markov chains

### `/setsassiness <0-100>`
Controls emotional expression:
- **0-25**: Calm, neutral
- **26-50**: Balanced
- **51-75**: Prefers emotional messages
- **76-100**: High energy with punctuation

### `/botstats`
Shows message count and current settings.

## How Triggers Work

| Factor | Multiplier | Example |
|--------|------------|---------|
| Base | 1x | Set by laziness |
| Question | 2x | "Anyone here?" |
| Keywords | 1.5x | Common chat words |
| Silence (15min+) | 3x | Inactivity |

- Max trigger chance: 90%
- Cooldown: 30 seconds between responses
- Response delay: 2-8 seconds (human-like)

## Best Practices

1. **Start with balanced settings**: Laziness 50, Coherence 50, Sassiness 50
2. **Let it learn**: Wait for 100+ messages before expecting good responses
3. **Adjust laziness first**: This has the biggest impact on behavior
4. **Higher coherence needs more data**: Set to 100 only after 500+ messages
5. **Russian language optimized**: Works best with Cyrillic text (main use case)

## Technical Details

- **Database**: SQLite (`data/markov.db`)
- **Storage limit**: 50,000 messages per chat (auto-cleanup)
- **Model caching**: Markov models cached for 10 minutes
- **Markov order**: Default 2 (can be adjusted in database, range 1-3)
- **Response delay**: Random 2-8 seconds (human-like typing)
- **Context matching**: Finds similar messages for relevant responses

## Privacy Notes

- Messages are stored **locally** in SQLite database
- Only text content saved (no media, links, or metadata)
- Bot's own messages are **not** saved or used for training
- Commands (starting with `/`) are ignored
- Works only in groups/supergroups (disabled in private chats by default)

## Troubleshooting

**Bot not responding:**
- Check `/botstats` - need at least 20 messages
- Feature enabled in `/settings`?
- Laziness too high (try lowering to 30-40)
- 30-second cooldown active

**Responses don't make sense:**
- Increase coherence (try 70+)
- Need more training data (500+ messages recommended)
- Lower Markov order in database (try 1 instead of 2)

**Bot responding too much:**
- Increase laziness (try 60-70)
- Check cooldown isn't being reset
- 30-second delay should prevent spam

**Random messages instead of AI:**
- Increase coherence to 80-100
- Check message count (need 50+ for good Markov chains)

## Example Configuration

**For quiet bot (lurker mode):**
```
/setlaziness 80
/setcoherence 90
/setsassiness 30
```

**For active participant:**
```
/setlaziness 30
/setcoherence 60
/setsassiness 70
```

**For meme lord:**
```
/setlaziness 40
/setcoherence 20
/setsassiness 95
```
