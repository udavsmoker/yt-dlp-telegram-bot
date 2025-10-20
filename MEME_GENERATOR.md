# Meme Generator

Generate memes using chat messages with customizable templates.

## Commands

- `/meme` - Random meme with random template
- `/meme list` - Show all available templates
- `/meme <template_name>` - Generate with specific template
- `/meme reload` - Reload templates from disk (admins only)

## Requirements

- Meme Generation enabled in `/settings`
- At least 10 messages in chat history
- Template files in `templates/` directory

## Creating Templates

### Structure

Each template needs two files in `templates/`:
1. Image file: `my_template.png` (or .jpg)
2. Config file: `my_template.json`

### Minimal JSON Example

```json
{
  "name": "my_template",
  "description": "My custom meme",
  "textBoxes": [
    {
      "x": 10,
      "y": 10,
      "width": 780,
      "fontSize": 48,
      "fontFamily": "Impact",
      "color": "white",
      "strokeColor": "black",
      "strokeWidth": 2,
      "align": "center",
      "uppercase": true
    }
  ]
}
```

### Text Box Properties

**Required:**
- `x`, `y` - Position (top-left corner)
- `width` - Maximum width before wrapping
- `fontSize` - Font size in pixels

**Optional:**
- `fontFamily` - Default: `"Arial"` (also: `"Impact"`, `"Comic Sans MS"`)
- `color` - Default: `"white"`
- `strokeColor` - Outline color, default: `"black"`
- `strokeWidth` - Outline thickness, default: `2`
- `align` - `"left"`, `"center"`, `"right"` (default: `"center"`)
- `uppercase` - Convert to uppercase, default: `false`
- `maxLines` - Max lines before truncating, default: `5`
- `lineHeight` - Line spacing multiplier, default: `1.2`
- `useSassyMessages` - Prefer emotional messages, default: `false`

## Template Examples

### Classic Top/Bottom Meme
```json
{
  "name": "classic_meme",
  "description": "Classic top/bottom text",
  "textBoxes": [
    {
      "x": 10, "y": 10, "width": 780,
      "fontSize": 48, "fontFamily": "Impact",
      "color": "white", "strokeColor": "black", "strokeWidth": 3,
      "align": "center", "uppercase": true, "maxLines": 2
    },
    {
      "x": 10, "y": 520, "width": 780,
      "fontSize": 48, "fontFamily": "Impact",
      "color": "white", "strokeColor": "black", "strokeWidth": 3,
      "align": "center", "uppercase": true, "maxLines": 2
    }
  ]
}
```

### Drake Meme
```json
{
  "name": "drake_meme",
  "description": "Drake yes/no format",
  "textBoxes": [
    {
      "x": 420, "y": 80, "width": 360,
      "fontSize": 36, "fontFamily": "Arial",
      "color": "black", "align": "left",
      "maxLines": 3, "lineHeight": 1.3
    },
    {
      "x": 420, "y": 380, "width": 360,
      "fontSize": 36, "fontFamily": "Arial",
      "color": "black", "align": "left",
      "maxLines": 3, "lineHeight": 1.3
    }
  ]
}
```

## Tips

**Image specs:**
- Format: PNG or JPG
- Size: 800x600 minimum
- Quality: High-quality source images recommended

**Text positioning:**
- Use image editor to find coordinates
- Leave 10-50px margins from edges
- Test with long and short messages

**Fonts:**
- **Impact** - Bold meme font
- **Arial** - Clean and readable
- **Comic Sans MS** - Playful

**Colors:**
- White text + black stroke = readable on any background
- Black text = clean on light backgrounds

## Troubleshooting

**"No templates available"**
- Check `templates/` directory exists
- Ensure matching `.png` and `.json` files
- Run `/meme reload`

**"Not enough messages"**
- Need 10+ messages in database
- Enable Markov Responses in `/settings`

**"Template validation failed"**
- Check JSON syntax
- Verify required fields: `x`, `y`, `width`, `fontSize`

**Text cut off**
- Increase `width` or `maxLines`
- Reduce `fontSize`

**Text hard to read**
- Add `strokeColor` and `strokeWidth`
- Use contrasting colors

