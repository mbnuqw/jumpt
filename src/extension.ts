import * as vscode from 'vscode'

enum AnchorMode {
  Default = 'default',
  FullWidth = 'fullWidth',
}

interface JumptSettings {
  anchors: string
  trigger: string | number
  scroll: boolean
  anchorMode: AnchorMode
  anchorPlaceholderChar: string
  anchorBg: string
  anchorFg: string
  queryBg: string
  queryFg: string
}

interface JumptState {
  settings: JumptSettings
  cancellation: vscode.CancellationTokenSource
  decorations: vscode.TextEditorDecorationType[]
  editors: JumptEditorInfo[]
  anchorIndex: number
  args?: JumptArgs
}

interface JumptEditorInfo {
  editor: vscode.TextEditor
  isActive: boolean
  text: string

  start: vscode.Position
  startOffset: number
  cursorOffset: number
  endOffset: number

  pre: string
  preIndex: number
  post: string
  postIndex: number

  targets: { [anchor: string]: vscode.Position }
}

interface JumptTarget {
  viewColumn: number
  position: vscode.Position
}

interface JumptArgs {
  select: boolean
}

const INPUT_PROMPT_TEXT = 'Enter jump query'
const INPUT_PLACEHOLDER_TEXT = (settings: JumptSettings): string => {
  let q = 'abc'
  let t = ' '
  if (typeof settings.trigger === 'string') {
    q = 'abc'
    t = settings.trigger
  }
  if (typeof settings.trigger === 'number') {
    q = 'abcdefg'.slice(0, settings.trigger)
    t = ''
  }
  return `e.g.: "${q}${t}X", where "${q}" - search query, "X" - target anchor`
}
const PREV_POSITIONS: JumptTarget[] = []

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.jumpt', jumptHandler),
    vscode.commands.registerCommand('extension.jumptback', jumptBackHandler)
  )
}

export function deactivate(): void {}

/**
 * Handle jumpt command
 */
async function jumptHandler(args: JumptArgs): Promise<void> {
  let editors: JumptEditorInfo[] = []
  for (let editor of vscode.window.visibleTextEditors) {
    if (!editor.viewColumn) continue

    let range = editor.visibleRanges[0]
    let selection = editor.selection

    let info = {
      editor,
      isActive: editor === vscode.window.activeTextEditor,
      text: editor.document.getText(range).toLowerCase(),

      start: selection.active,
      startOffset: editor.document.offsetAt(range.start),
      cursorOffset: editor.document.offsetAt(selection.active),
      endOffset: editor.document.offsetAt(range.end),
      anchorIndex: 0,

      pre: '',
      preIndex: 0,
      post: '',
      postIndex: 0,

      targets: {},
    }

    if (info.cursorOffset < info.startOffset || info.cursorOffset > info.endOffset) {
      info.cursorOffset = info.startOffset
      info.post = info.text
    } else {
      info.pre = info.text.slice(0, info.cursorOffset - info.startOffset)
      info.post = info.text.slice(info.cursorOffset - info.startOffset)
    }

    editors.push(info)
  }

  if (!editors.length) return

  let settings = vscode.workspace.getConfiguration('jumpt')
  let state: JumptState = {
    settings: (settings as unknown) as JumptSettings,
    cancellation: new vscode.CancellationTokenSource(),
    decorations: [],
    anchorIndex: 0,
    editors,
    args,
  }

  let output = await vscode.window.showInputBox(
    {
      prompt: INPUT_PROMPT_TEXT,
      placeHolder: INPUT_PLACEHOLDER_TEXT(state.settings),
      validateInput: keyHandler.bind(state),
    },
    state.cancellation.token
  )

  if (output && state.decorations.length === 1) jumpToFirstTarget(state)

  reset(state)
}

/**
 * Just to first target (used with only one target).
 */
function jumpToFirstTarget(state: JumptState): void {
  let info = state.editors.find(e => Object.values(e.targets).length)
  if (info) {
    saveCurrentPosition()
    let target = Object.values(info.targets)[0]
    let selection = new vscode.Selection(target, target)
    info.editor.selections = [selection]
    focusColumn(info.editor.viewColumn as number)
    if (state.settings.scroll) scrollToSelectionsCenter()
  }
}

/**
 * Handle key events from input box
 */
function keyHandler(this: JumptState, value: string): undefined {
  if (!value) {
    reset(this)
    return
  }

  let targetAnchor: string | undefined
  let trigger: string | number = this.settings.trigger
  if (typeof trigger === 'number') {
    targetAnchor = value[trigger]
    value = value.slice(0, trigger)
  } else {
    let index = value.indexOf(trigger)
    if (index > -1) {
      targetAnchor = value[value.length - 1]
      value = value.slice(0, index)
    }
  }

  if (targetAnchor) {
    for (let info of this.editors) {
      let target
      target = info.targets[targetAnchor]

      if (target) {
        saveCurrentPosition()
        let start = this.args?.select ? info.start : target
        info.editor.selections = [new vscode.Selection(start, target)]
        reset(this)
        if (this.cancellation) this.cancellation.cancel()
        focusColumn(info.editor.viewColumn as number)
        if (this.settings.scroll) scrollToSelectionsCenter()
        return
      }
    }
  }

  reset(this)

  let editorIndex = this.editors.findIndex(e => e.isActive)
  if (editorIndex === -1) editorIndex = 0

  while (this.settings.anchors[this.anchorIndex]) {
    let info = this.editors[editorIndex++]
    if (editorIndex === this.editors.length) editorIndex = 0
    if (info.postIndex > -1) setAnchorBelow(this, info, value)
    if (info.preIndex > -1) setAnchorAbove(this, info, value)
    if (info.postIndex === -1 && info.preIndex === -1) {
      if (this.editors.every(e => e.postIndex < 0 && e.preIndex < 0)) break
      else continue
    }
  }
}

/**
 * Focus column
 */
function focusColumn(i: number): void {
  let exec = vscode.commands.executeCommand
  if (i === 1) exec('workbench.action.focusFirstEditorGroup')
  if (i === 2) exec('workbench.action.focusSecondEditorGroup')
  if (i === 3) exec('workbench.action.focusThirdEditorGroup')
  if (i === 4) exec('workbench.action.focusFourthEditorGroup')
}

/**
 * Generate matched text placeholder
 */
function getQueryPlaceholder(anchor: string, query: string, char: string): string {
  let len = query.length - 1
  let pre = Math.ceil(len / 2)
  let post = Math.floor(len / 2)
  return char.repeat(pre) + anchor + char.repeat(post)
}

/**
 * Set decoration for provided area
 */
function setStringDecoration(
  state: JumptState,
  info: JumptEditorInfo,
  startOffset: number,
  targetString: string,
  bg: string,
  fg: string
): void {
  let start = info.editor.document.positionAt(startOffset)
  let end = info.editor.document.positionAt(startOffset + targetString.length)
  let deco = vscode.window.createTextEditorDecorationType({
    letterSpacing: '-16px',
    opacity: '0',
    before: {
      contentText: targetString,
      backgroundColor: bg,
      color: fg,
      fontWeight: '700',
    },
  })
  let range = new vscode.Range(start, end)
  state.decorations.push(deco)
  info.editor.setDecorations(deco, [range])
}

/**
 * Set decoration for matched text and anchor
 */
function setAnchor(
  state: JumptState,
  info: JumptEditorInfo,
  startOffset: number,
  anchor: string,
  query: string
): void {
  info.targets[anchor] = info.editor.document.positionAt(startOffset)
  let anchorBg = state.settings.anchorBg
  let anchorFg = state.settings.anchorFg

  if (query.length === anchor.length) {
    return setStringDecoration(state, info, startOffset, query, anchorBg, anchorFg)
  }

  if (state.settings.anchorMode === AnchorMode.FullWidth) {
    let text = getQueryPlaceholder(anchor, query, state.settings.anchorPlaceholderChar)

    setStringDecoration(state, info, startOffset, text, anchorBg, anchorFg)
  } else {
    let queryBg = state.settings.queryBg
    let queryFg = state.settings.queryFg
    let queryText = query.substr(anchor.length)

    setStringDecoration(state, info, startOffset, anchor, anchorBg, anchorFg)
    setStringDecoration(state, info, startOffset + anchor.length, queryText, queryBg, queryFg)
  }
}

/**
 * Set next anchor
 */
function setAnchorBelow(state: JumptState, info: JumptEditorInfo, query: string): void {
  let anchor: string = state.settings.anchors[state.anchorIndex]
  if (!anchor) return

  info.postIndex = info.post.indexOf(query, info.postIndex)
  if (info.postIndex !== -1) {
    setAnchor(state, info, info.cursorOffset + info.postIndex, anchor, query)
    info.postIndex++
    state.anchorIndex++
  }
}

/**
 * Set prev anchor
 */
function setAnchorAbove(state: JumptState, info: JumptEditorInfo, query: string): void {
  let anchor: string = state.settings.anchors[state.anchorIndex]
  if (!anchor) return

  info.preIndex = info.pre.lastIndexOf(query, info.preIndex)
  if (info.preIndex !== -1) {
    setAnchor(state, info, info.startOffset + info.preIndex, anchor, query)
    info.preIndex--
    state.anchorIndex++
  }
}

/**
 * Reset anchors and decorations
 */
function reset(state: JumptState): void {
  state.anchorIndex = 0
  for (let info of state.editors) {
    info.targets = {}
    info.preIndex = info.pre.length
    info.postIndex = 0
  }
  state.decorations.map(d => d.dispose())
  state.decorations = []
}

/**
 * Handle jumpt back command
 */
function jumptBackHandler(): void {
  if (!PREV_POSITIONS.length) return

  let pos = PREV_POSITIONS.pop()
  if (!pos) return
  let editor = vscode.window.visibleTextEditors.find(e => {
    if (pos) return e.viewColumn === pos.viewColumn
  })
  if (!editor || !editor.viewColumn) return
  editor.selections = [new vscode.Selection(pos.position, pos.position)]

  focusColumn(editor.viewColumn)

  let settings = vscode.workspace.getConfiguration('jumpt')
  if (settings.scroll) scrollToSelectionsCenter()
}

/**
 * Save current position
 */
function saveCurrentPosition(): void {
  let editor = vscode.window.activeTextEditor
  if (!editor || !editor.viewColumn) return
  let position = editor.selection.active
  let prevPosition = PREV_POSITIONS[PREV_POSITIONS.length - 1]
  if (!prevPosition || !prevPosition.position.isEqual(position)) {
    PREV_POSITIONS.push({ viewColumn: editor.viewColumn, position })
  }
}

/**
 * Scroll to selections center with delay
 */
function scrollToSelectionsCenter(delay = 125): void {
  setTimeout(() => {
    let editor = vscode.window.activeTextEditor
    if (!editor) return

    let sorted = editor.selections.sort((a, b) => {
      return a.active.compareTo(b.active)
    })
    let first = sorted[0].active
    let last = sorted[sorted.length - 1].active
    let targetLine = Math.ceil(first.line + last.line) / 2

    vscode.commands.executeCommand('revealLine', {
      lineNumber: targetLine,
      at: 'center',
    })
  }, delay)
}
