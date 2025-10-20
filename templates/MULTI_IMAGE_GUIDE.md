# Multi-Image Template Guide

## Overview
Templates can now support multiple images with random selection and automatic text positioning.

## Three Ways to Add Multiple Images

### 1. Folder Method (Recommended)
Create a folder with the template name and put all images inside:
```
templates/
  classic_meme/
    image1.jpg
    image2.jpg
    image3.jpg
  classic_meme.json
```

In `classic_meme.json`, set `"image"` to the folder name:
```json
{
  "name": "classic_meme",
  "image": "classic_meme",
  ...
}
```

### 2. Pattern Matching Method
Name images with numbers: `classic_meme1.jpg`, `classic_meme2.jpg`, etc.
```
templates/
  classic_meme1.jpg
  classic_meme2.jpg
  classic_meme3.jpg
  classic_meme.json
```

In `classic_meme.json`, set `"image"` to the base name:
```json
{
  "name": "classic_meme",
  "image": "classic_meme",
  ...
}
```

The system will automatically find all images matching the pattern `classic_meme1.jpg`, `classic_meme2.jpg`, etc.

### 3. Single Image (Traditional)
Just use a single image filename:
```json
{
  "name": "classic_meme",
  "image": "classic_meme.jpg",
  ...
}
```

## Automatic Text Positioning

### Manual Positioning (Old Way)
Specify exact coordinates:
```json
{
  "textBoxes": [
    {
      "x": 10,
      "y": 10,
      "width": 780,
      ...
    }
  ]
}
```

### Auto-Positioning (New Way)
Remove `x` and `y` coordinates to enable auto-positioning:
```json
{
  "textBoxes": [
    {
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true
    },
    {
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

**How it works:**
- First text box → Top center (50px from top)
- Second text box → Bottom center (50px from bottom)
- Width automatically set to 90% of image width
- Text centered horizontally

## Example: Complete Auto-Position Template

```json
{
  "name": "classic_meme",
  "description": "Classic top/bottom text meme with multiple images",
  "image": "classic_meme",
  "textBoxes": [
    {
      "maxLines": 3,
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true,
      "lineHeight": 55,
      "useSassyMessages": false
    },
    {
      "maxLines": 3,
      "fontSize": 48,
      "fontFamily": "Impact, Arial Black, sans-serif",
      "color": "#FFFFFF",
      "strokeColor": "#000000",
      "strokeWidth": 4,
      "uppercase": true,
      "lineHeight": 55,
      "useSassyMessages": false
    }
  ]
}
```

## Benefits

1. **Variety**: One template can use many different images
2. **Simplicity**: No need to calculate coordinates for each image
3. **Flexibility**: Mix manual and auto-positioning in same template
4. **Scalability**: Add new images without editing JSON

## Testing

1. Create folder `templates/classic_meme/` with multiple images
2. Update `classic_meme.json` to use `"image": "classic_meme"`
3. Remove `x` and `y` from textBoxes
4. Run `/meme reload` (creator only)
5. Test with `/meme classic_meme` multiple times to see random selection
