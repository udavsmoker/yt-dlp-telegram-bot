# Auto-Positioning Visual Guide

## How Auto-Positioning Works

```
┌─────────────────────────────────────┐
│                                     │ ← 50px padding
│        TOP TEXT HERE (index 0)      │ ← First textBox (auto)
│                                     │
│                                     │
│                                     │
│         [MEME IMAGE]                │
│                                     │
│                                     │
│                                     │
│      BOTTOM TEXT HERE (index 1)     │ ← Second textBox (auto)
│                                     │ ← 50px padding
└─────────────────────────────────────┘
```

## Text Width Calculation

```
Image width: 800px
Text width: 800px * 0.9 = 720px
Left margin: (800 - 720) / 2 = 40px
Right margin: 40px

┌────────────────────────────────────────┐
│                                        │
│ 40px │← TEXT WIDTH (720px) →│ 40px    │
│                                        │
└────────────────────────────────────────┘
```

## Positioning Logic

### First Text Box (index = 0)
- **x**: `imageWidth / 2` (center horizontally)
- **y**: `50` (50px from top)
- **width**: `imageWidth * 0.9` (90% of image)
- **align**: `center`

### Second Text Box (index = 1)
- **x**: `imageWidth / 2` (center horizontally)
- **y**: `imageHeight - 50` (50px from bottom)
- **width**: `imageWidth * 0.9` (90% of image)
- **align**: `center`

## Examples with Different Image Sizes

### Square Image (800x800)
```
Top text:    x=400, y=50
Bottom text: x=400, y=750
Text width:  720px
```

### Vertical Image (600x1000)
```
Top text:    x=300, y=50
Bottom text: x=300, y=950
Text width:  540px
```

### Horizontal Image (1200x600)
```
Top text:    x=600, y=50
Bottom text: x=600, y=550
Text width:  1080px
```

## Manual Override

You can still manually position any text box:

```json
{
  "textBoxes": [
    {
      "fontSize": 48
      // No x/y → auto-position at top
    },
    {
      "x": 100,
      "y": 700,
      "width": 600,
      "fontSize": 36
      // Has x/y → use these coordinates
    }
  ]
}
```

## Word Wrapping

Text automatically wraps based on:
- **width**: Available space
- **maxLines**: Maximum number of lines
- **lineHeight**: Space between lines

Example with `maxLines: 3`:
```
┌──────────────────────┐
│  THIS IS A VERY      │ ← Line 1
│  LONG TEXT THAT      │ ← Line 2
│  WRAPS NICELY        │ ← Line 3
└──────────────────────┘
```

If text exceeds `maxLines`, it gets truncated with "..."
