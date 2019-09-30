import * as vscode from 'vscode'

interface JumptSettings {
  anchors: string
  trigger: string | number
  scroll: boolean
  bg: string
  fg: string
}

interface JumptState {
  settings: JumptSettings
  cancellation: vscode.CancellationTokenSource
  decorations: vscode.TextEditorDecorationType[]
  editors: JumptEditorInfo[]
  anchorIndex: number
}

interface JumptEditorInfo {
  editor: vscode.TextEditor
  isActive: boolean
  text: string

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

const INPUT_PROMPT_TEXT = 'Enter jump query'
const INPUT_PLACEHOLDER_TEXT = (settings: JumptSettings) => {
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

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.jumpt', jumptHandler),
    vscode.commands.registerCommand('extension.jumptback', jumptBackHandler)
  )
}

export function deactivate() {}

/**
 * Handle jumpt command
 */
async function jumptHandler() {
  let editors: JumptEditorInfo[] = []
  for (let editor of vscode.window.visibleTextEditors) {
    if (!editor.viewColumn) continue

    let range = editor.visibleRanges[0]
    let selection = editor.selection

    let info = {
      editor,
      isActive: editor === vscode.window.activeTextEditor,
      text: editor.document.getText(range).toLowerCase(),

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

    if (
      info.cursorOffset < info.startOffset ||
      info.cursorOffset > info.endOffset
    ) {
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
    settings: (<unknown>settings) as JumptSettings,
    cancellation: new vscode.CancellationTokenSource(),
    decorations: [],
    anchorIndex: 0,
    editors,
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
function jumpToFirstTarget(state: JumptState) {
  let info = state.editors.find(e => Object.values(e.targets).length)
  if (info) {
    saveCurrentPosition()
    let target = Object.values(info.targets)[0]
    let selection = new vscode.Selection(target, target)
    info.editor.selections = [selection]
    focusColumn(info.editor.viewColumn)
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
      targetAnchor = value[index + 1]
      value = value.slice(0, index)
    }
  }

  if (targetAnchor) {
    for (let info of this.editors) {
      let target
      target = info.targets[targetAnchor]

      if (target) {
        saveCurrentPosition()
        info.editor.selections = [new vscode.Selection(target, target)]
        reset(this)
        if (this.cancellation) this.cancellation.cancel()
        focusColumn(info.editor.viewColumn)
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
function focusColumn(i: any) {
  let exec = vscode.commands.executeCommand
  if (i === 1) exec('workbench.action.focusFirstEditorGroup')
  if (i === 2) exec('workbench.action.focusSecondEditorGroup')
  if (i === 3) exec('workbench.action.focusThirdEditorGroup')
  if (i === 4) exec('workbench.action.focusFourthEditorGroup')
}

/**
 * Create decorator type for the anchor
 */
function createDecoratorType(
  state: JumptState,
  anchor: string,
  len: number
): vscode.TextEditorDecorationType {
  len -= 1

  let pre = Math.ceil(len / 2)
  let post = Math.floor(len / 2)
  let text = '_'.repeat(pre) + anchor + '_'.repeat(post)

  return vscode.window.createTextEditorDecorationType({
    letterSpacing: '-16px',
    opacity: '0',
    before: {
      contentText: text,
      backgroundColor: state.settings.bg,
      color: state.settings.fg,
      fontWeight: '700',
    },
  })
}

/**
 * Set next anchor
 */
function setAnchorBelow(
  state: JumptState,
  info: JumptEditorInfo,
  query: string
) {
  let anchor: string = state.settings.anchors[state.anchorIndex]
  if (!anchor) return

  info.postIndex = info.post.indexOf(query, info.postIndex)
  if (info.postIndex !== -1) {
    let deco = createDecoratorType(state, anchor, query.length)
    let startOffset = info.cursorOffset + info.postIndex
    let start = info.editor.document.positionAt(startOffset)
    let end = info.editor.document.positionAt(startOffset + query.length)
    let range = new vscode.Range(start, end)
    state.decorations.push(deco)
    info.targets[anchor] = range.start
    info.editor.setDecorations(deco, [range])
    info.postIndex++
    state.anchorIndex++
  }
}

/**
 * Set prev anchor
 */
function setAnchorAbove(
  state: JumptState,
  info: JumptEditorInfo,
  query: string
) {
  let anchor: string = state.settings.anchors[state.anchorIndex]
  if (!anchor) return

  info.preIndex = info.pre.lastIndexOf(query, info.preIndex)
  if (info.preIndex !== -1) {
    let deco = createDecoratorType(state, anchor, query.length)
    let startOffset = info.startOffset + info.preIndex
    let start = info.editor.document.positionAt(startOffset)
    let end = info.editor.document.positionAt(startOffset + query.length)
    let range = new vscode.Range(start, end)
    state.decorations.push(deco)
    info.targets[anchor] = range.start
    info.editor.setDecorations(deco, [range])
    info.preIndex--
    state.anchorIndex++
  }
}

/**
 * Reset anchors and decorations
 */
function reset(state: JumptState) {
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
function jumptBackHandler() {
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
function saveCurrentPosition() {
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
function scrollToSelectionsCenter(delay: number = 125) {
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
