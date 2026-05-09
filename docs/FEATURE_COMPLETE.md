# Multi-Image & Auto-Positioning Feature

Templates support multiple images with automatic text positioning.

## Features

### Multiple Images Per Template

**Three methods:**
- **Folder**: `templates/meme_name/` with images inside
- **Pattern**: `meme1.jpg`, `meme2.jpg`, `meme3.jpg`
- **Single**: Traditional single image (backward compatible)

### Auto-Positioning

Omit `x` and `y` from text boxes:
- First box: Top center (50px from top)
- Second box: Bottom center (50px from bottom)
- Width: 90% of image width
- Alignment: Center

## Usage

### Create Multi-Image Template

**Option A: Folder**
```bash
mkdir templates/my_template
# Add images to templates/my_template/
```

**Option B: Pattern**
```bash
# Create: my_template1.jpg, my_template2.jpg, my_template3.jpg
```

### Create JSON

```json
{
  "name": "my_template",
  "description": "Template with auto-positioning",
  "image": "my_template",
  "textBoxes": [
    {
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true,
      "maxLines": 3
    },
    {
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true,
      "maxLines": 3
    }
  ]
}
```

**Changes from old format:**
- Remove `x` and `y` for auto-positioning
- Remove `width` (optional)
- Set `image` to folder name or base name

### Reload
```
/meme reload
```

## Implementation

**Random selection:**
```javascript
const randomImagePath = template.imagePaths[
  Math.floor(Math.random() * template.imagePaths.length)
];
```

**Auto-positioning:**
- First box: `y = 50`, `x = imageWidth / 2`
- Second box: `y = imageHeight - 50`, `x = imageWidth / 2`
- Width: `imageWidth * 0.9`

## Backward Compatibility

- All existing templates work without changes
- Manual positioning still supported
- Single images still work
- Can mix manual and auto-positioning

## Example

**Before:**
```json
{
  "image": "meme.jpg",
  "textBoxes": [
    {"x": 10, "y": 10, "width": 780, ...},
    {"x": 10, "y": 550, "width": 780, ...}
  ]
}
```

**After:**
```json
{
  "image": "meme",
  "textBoxes": [
    {"fontSize": 48, ...},
    {"fontSize": 48, ...}
  ]
}
```

**Folder:**
```
templates/
  meme/
    variant1.jpg
    variant2.jpg
    variant3.jpg
  meme.json
```

