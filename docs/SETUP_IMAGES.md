# ⚠️ Template Images Needed

The meme generator system is now fully implemented, but you need to add template images!

## Quick Setup

1. **Download or create meme template images:**
   - Classic meme blank template (800x600 or larger)
   - Demotivator style template (with black border/background)
   - Drake meme template (2-panel format)
   - Or any custom images you want!

2. **Save images in `templates/` directory:**
   - `templates/classic_meme.png`
   - `templates/demotivator.png`
   - `templates/drake_meme.png`

3. **Image requirements:**
   - Format: PNG or JPG
   - Size: 800x600 minimum (recommended 1200x900 or larger)
   - File name must match the JSON file name (e.g., `classic_meme.png` → `classic_meme.json`)

## Where to Find Template Images

### Option 1: Search Online
- Google: "meme template blank" or "demotivator template"
- Sites: imgflip.com, kapwing.com, mematic.net
- Download high-quality versions

### Option 2: Create Your Own
- Use any image editing software (Photoshop, GIMP, Canva)
- Create blank canvas with your desired size
- Add decorative elements (borders, backgrounds, etc.)
- Save as PNG for best quality

### Option 3: Use Existing Meme Images
- Take any meme template from the internet
- The JSON config will define where text is placed
- Bot will render text on top of the image

## Testing

Once you have images:

1. Place images in `templates/` directory
2. Ensure JSON files exist with matching names
3. Start bot: `npm start`
4. Enable feature: `/settings` → toggle **Meme Generator**
5. Test: `/meme list` (should show your templates)
6. Generate: `/meme` or `/meme classic_meme`

## Current Status

✅ Meme service implemented
✅ JSON templates created (3 examples)
✅ Command handler integrated
✅ Settings integration complete
✅ Documentation written

❌ **Need to add image files** (see above)

## Example Images to Create

### 1. Classic Meme (classic_meme.png)
- 800x600 solid color background (or any image)
- Leave space at top and bottom for text
- JSON config expects text at y=10 (top) and y=520 (bottom)

### 2. Demotivator (demotivator.png)
- Black background (800x600)
- Optional: white border/frame in center for image
- Russian demotivator style (black border, centered image)
- JSON config expects title at y=480, subtitle at y=550

### 3. Drake Meme (drake_meme.png)
- Standard Drake meme template (2 panels)
- Left side: Drake's face (disapproving + approving)
- Right side: blank space for text
- 800x600 recommended
- JSON config expects text at x=420 for both panels

## Need Help?

See `MEME_GENERATOR.md` for full documentation on:
- Creating custom templates
- Text box positioning
- Font selection
- Color schemes
- Troubleshooting

---

**TL;DR:** Download 3 meme template images from the internet and save them as:
- `templates/classic_meme.png`
- `templates/demotivator.png`  
- `templates/drake_meme.png`

Then run `/meme list` to test!
