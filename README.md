# JumpᏆ

Simple vscode extension for fast navigation.

## Features
- Support multi-columns layout
- Jump back command
- Auto-scroll

![demo-1](assets/demo-1.gif)

## Usage
- Activate jumpt input (configure shortcut or find in command palette)
- Enter target sub-string
- Use one of configured triggering methods:
  - Enter separator sign, then target anchor sign
  - Enter target anchor sign after search query with static length


## Commands
- extension.jumpt - activate jump input  
  ```json
  {
    "key": "...",
    "command": "extension.jumpt"
  },
  {
    "key": "...",
    "command": "extension.jumpt",
    "args": { "select": true }
  },
  ```
- extension.jumptback - jump back  
  ```json
  {
    "key": "...",
    "command": "extension.jumptback"
  },
  ```


## Settings
__Anchors__  
Available anchor signs.  
`jumpt.anchors: string`  
`default: "fjdksla;vmbcghieorwnp/FJALKMVCER"`

__Trigger__  
Separator char between a search query and target anchor or static length of the search query followed by target anchor.  
`jumpt.trigger: string | number`  
`default: " "`

__Auto-scroll__  
Auto-scroll to new position.  
`jumpt.scroll: boolean`  
`default: false`

__Background color__  
Anchor background color.  
`jumpt.bg: string`  
`default: "#0C82F7"`

__Foreground color__  
Anchor foreground color.  
`jumpt.fg: string`  
`default: "#ffffff"`


## Alternatives
- Find-Jump
- Find-Then-Jump
- Xray-Jump
- Jumpy
- Code Ace Jumper


## Licence
MIT