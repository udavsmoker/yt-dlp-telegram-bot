# Meme Templates Guide

Templates for generating memes with chat messages.

## New Features

- **Multiple Images** - One template can use many images (random selection)
- **Auto-Positioning** - Text automatically positions at top/bottom center
- See `MULTI_IMAGE_GUIDE.md` for details

## Template Structure

Each template needs:
1. **JSON file** - Text placement and styling
2. **Image(s)**:
   - Single: `template.jpg`
   - Multiple: folder `template/` or numbered `template1.jpg`, `template2.jpg`

## JSON Format

### Manual Positioning
```json
{
  "name": "template_name",
  "description": "Template description",
  "image": "image_filename.jpg",
  "textBoxes": [
    {
      "x": 10,
      "y": 10,
      "width": 500,
      "maxLines": 3,
      "fontSize": 40,
      "fontFamily": "Impact, Arial",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 3,
      "align": "center",
      "uppercase": true
    }
  ]
}
```

### Auto-Positioning
```json
{
  "name": "template_name",
  "description": "Auto-positioned template",
  "image": "template_name",
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

**Note:** Omit `x`, `y`, `width` for auto-positioning (top center / bottom center).

## Fields

### Template
- **name** - Unique name (no spaces)
- **description** - Human-readable description
- **image** - Filename, folder name, or base name for patterns

### Text Box
- **x**, **y** - Position (omit for auto)
- **width** - Max width (omit for auto)
- **maxLines** - Default: 10
- **fontSize** - Default: 40
- **fontFamily** - Default: "Impact, Arial"
- **color** - Text color (hex), default: "#FFFFFF"
- **strokeColor** - Outline color, default: "#000000"
- **strokeWidth** - Outline thickness, default: 3
- **align** - "left", "center", "right"
- **uppercase** - Default: true
- **lineHeight** - Default: fontSize * 1.2
- **useSassyMessages** - Prefer messages with ! or ?

## Creating Templates

### Multi-Image + Auto-Position (Recommended)

**1. Prepare images:**
```
templates/
  my_meme/
    variant1.jpg
    variant2.jpg
    variant3.jpg
  my_meme.json
```

**2. Create JSON:**
```json
{
  "name": "my_meme",
  "description": "My meme",
  "image": "my_meme",
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

### Manual Positioning

**1. Create image** (800x600 recommended)
**2. Find coordinates** using image editor
**3. Create JSON** with x, y, width
**4. Test** with `/meme template_name`

## Tips

**Russian text:**
- Use Cyrillic fonts: "Arial", "Helvetica", "DejaVu Sans"
- Impact has limited Cyrillic support

**Sassy messages:**
- `"useSassyMessages": true` prefers messages with ! or ?

**Font stack:**
```json
"fontFamily": "Impact, Arial Black, Arial, sans-serif"
```

## Troubleshooting

**Template not loading:**
- Check JSON syntax
- Verify image file exists
- Check filename case

**Text doesn't fit:**
- Reduce fontSize
- Increase width or maxLines

**Wrong font:**
- Use system fonts only
- Safe: Impact, Arial, Helvetica

## Commands

```
/meme - Random meme
/meme classic_meme - Specific template
/meme list - Show all templates
/meme reload - Reload from disk (admin)
```

