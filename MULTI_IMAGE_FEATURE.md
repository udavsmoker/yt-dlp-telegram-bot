# Multi-Image & Auto-Positioning Implementation

## Features

### Multiple Images Per Template

**Three methods:**

**A. Folder (Recommended)**
```
templates/
  classic_meme/
    variant1.jpg
    variant2.jpg
    variant3.jpg
  classic_meme.json
```

JSON: `"image": "classic_meme"`

**B. Pattern Matching**
```
templates/
  classic_meme1.jpg
  classic_meme2.jpg
  classic_meme3.jpg
  classic_meme.json
```

JSON: `"image": "classic_meme"`

**C. Single Image**
JSON: `"image": "classic_meme.jpg"`

### Auto-Positioning

**Old (manual):**
```json
{
  "textBoxes": [
    {"x": 10, "y": 10, "width": 780, ...}
  ]
}
```

**New (auto):**
```json
{
  "textBoxes": [
    {"fontSize": 48, "fontFamily": "Impact", ...}
  ]
}
```

**Rules:**
- First box: Top center (50px from top)
- Second box: Bottom center (50px from bottom)
- Width: 90% of image width
- Alignment: Center

## Implementation

### Code Changes in `meme.service.js`

**`loadTemplates()`**
- Checks if `template.image` is directory
- Loads all images from folder or pattern
- Stores `imagePaths` array

**`generateMeme()`**
- Picks random image: `imagePaths[Math.floor(Math.random() * imagePaths.length)]`
- Passes to `renderMeme()`

**`renderMeme()`**
- Accepts `imagePath` parameter
- Calls `calculatePosition()` for each text box

**`calculatePosition()` (new)**
- If `x` and `y` defined: manual positioning
- If not: auto-position (top center for first, bottom center for second)
- Default width: 90% of image

## Example Usage

### Multi-Image with Auto-Positioning

**1. Create folder:**
```bash
mkdir templates/classic_meme
# Add: variant1.jpg, variant2.jpg, variant3.jpg
```

**2. JSON:**
```json
{
  "name": "classic_meme",
  "description": "Classic meme with auto-positioning",
  "image": "classic_meme",
  "textBoxes": [
    {
      "maxLines": 3,
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true
    },
    {
      "maxLines": 3,
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true
    }
  ]
}
```

**3. Reload:**
```
/meme reload
```

**4. Generate:**
```
/meme classic_meme
```

### Mixed Positioning

```json
{
  "textBoxes": [
    {"fontSize": 48, ...},  // Auto (top)
    {"x": 100, "y": 650, "width": 600, "fontSize": 36, ...}  // Manual
  ]
}
```

   - Create folder with 3+ images
   - Run `/meme reload`
   - Generate meme 5-10 times
   - Verify different images are selected

3. **Test pattern matching:**
   - Rename images to template1.jpg, template2.jpg
   - Run `/meme reload`
   - Verify multiple images detected

4. **Test auto-positioning:**
   - Remove x/y from textBoxes
   - Run `/meme reload`
   - Verify text appears at top/bottom center

5. **Test mixed positioning:**
   - One box with x/y, one without
   - Verify manual box uses coordinates
   - Verify auto box positions correctly

## Benefits

✅ **Variety**: One template = many images (no duplicate templates needed)
✅ **Simplicity**: No coordinate calculations for different image sizes
✅ **Flexibility**: Mix manual and auto-positioning
✅ **Scalability**: Add images without editing JSON
✅ **Backward Compatible**: Old templates work without changes

## Migration Guide

### Option 1: Keep Existing Templates As-Is
- No changes needed
- Templates with manual x/y will continue to work

### Option 2: Convert to Auto-Positioning
1. Remove `x`, `y`, and `width` from textBoxes
2. Optionally remove `align` (defaults to center)
3. Reload templates

### Option 3: Add Multiple Images
**Method A (Folder):**
1. Create folder: `templates/template_name/`
2. Move image to folder, add more images
3. Change `"image": "template_name.jpg"` → `"image": "template_name"`

**Method B (Pattern):**
1. Rename: `template.jpg` → `template1.jpg`
2. Add: `template2.jpg`, `template3.jpg`, etc.
3. Change `"image": "template.jpg"` → `"image": "template"`

## Files Created/Modified

### Modified:
- `src/services/meme.service.js` - Main implementation

### Created:
- `templates/MULTI_IMAGE_GUIDE.md` - User guide
- `templates/classic_meme_auto.json` - Example template with auto-positioning

### Not Modified:
- `src/handlers/meme.handler.js` - No changes needed
- Existing templates - All backward compatible
