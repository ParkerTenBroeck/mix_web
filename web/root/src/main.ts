import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, hoverTooltip, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleLineComment } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { mixLanguage } from "./mix-language.ts";
import { canvasExample, simpleExample } from "./examples.ts";
import wasm from "./wasm.ts";

type FileModel = { id: string; name: string; contents: string };
type Project = { files: FileModel[]; activeId: string; theme: "dark" | "light" };
type RunResult = { ok: boolean; output: string };
type FrameResult = {
  ok: boolean;
  output: string;
  state?: string;
  draw: DrawCommand[];
  completed: boolean;
  instruction?: number;
  evaluator?: EvaluatorSnapshot;
  source?: { file: string; range: [number, number] };
};
type StackEntry = { summary: string; detail: string };
type EvaluatorSnapshot = { values: StackEntry[]; thunks: StackEntry[]; frames: StackEntry[] };
type DrawCommand = Record<string, unknown> & { kind?: string; type?: string };
type ReportSpan = { range: [number, number]; fid: number };
type SerializedReport = {
  level: "Error" | "Warning" | "Info";
  title: string;
  span: ReportSpan;
  annotations: { kind: "Primary" | "Context"; span: ReportSpan; label?: string }[];
};
type CompileResult = {
  ok: boolean;
  output: string;
  disassembly: string;
  reports: { reports?: SerializedReport[]; message?: string };
  files: string[];
};
type EditorDiagnostic = { from: number; to: number; level: SerializedReport["level"]; message: string };
type IdentifierToken = { from: number; to: number; name: string; definition: boolean };

const starter = simpleExample;
const storageKey = "mix-playground-project-v1";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabList = $<HTMLDivElement>("tabList");
const output = $<HTMLPreElement>("output");
const runStatus = $<HTMLSpanElement>("runStatus");
const cursorStatus = $<HTMLSpanElement>("cursorStatus");
const saveState = $<HTMLSpanElement>("saveState");
const runnerMode = $<HTMLSelectElement>("runnerMode");
const deepEval = $<HTMLInputElement>("deepEval");
const runnerCanvas = $<HTMLCanvasElement>("runnerCanvas");
const runnerViewSwitch = $<HTMLDivElement>("runnerViewSwitch");
const exampleSelect = $<HTMLSelectElement>("exampleSelect");
const fileDialog = $<HTMLDialogElement>("fileDialog");
const fileDialogForm = $<HTMLFormElement>("fileDialogForm");
const fileNameInput = $<HTMLInputElement>("fileNameInput");
const fileNameError = $<HTMLParagraphElement>("fileNameError");
const deleteDialog = $<HTMLDialogElement>("deleteDialog");
const deleteDialogForm = $<HTMLFormElement>("deleteDialogForm");
const disassembly = $<HTMLPreElement>("disassembly");
const workbench = $<HTMLDivElement>("workbench");

let project = loadProject();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let compileTimer: ReturnType<typeof setTimeout> | undefined;
let editor: EditorView;
let projectRevision = 0;
let compiledRevision = -1;
let compiledEntry: string | undefined;
let compileRequest = 0;
let diagnosticsByFile = new Map<string, EditorDiagnostic[]>();
let disassemblyText = "";
let loopRunning = false;
let debugRunning = false;
let loopInitialized = false;
let loopReady = false;
let evaluationInitialized = false;
let loopFrame: number | undefined;
let evaluationFuel = 1_000;
let loopFuel = 1_000;
const targetBatchMs = 10;
let previousLoopState: string | undefined;
let loopView: "canvas" | "output" = "canvas";
let loopFrameNumber = 0;
let currentFrameInput: string | undefined;
let pendingFrameComputeMs = 0;
let frameComputeSamples: number[] = [];
const heldKeys = new Set<string>();
const pressedKeys = new Set<string>();
const releasedKeys = new Set<string>();

const setDiagnostics = StateEffect.define<EditorDiagnostic[]>();
const setEvaluationRange = StateEffect.define<{ from: number; to: number } | null>();
const setHoveredIdentifier = StateEffect.define<number | null>();
const diagnosticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setDiagnostics)) continue;
      value = Decoration.set(effect.value.map((diagnostic) => Decoration.mark({
        class: `mix-diagnostic mix-diagnostic-${diagnostic.level.toLowerCase()}`,
        attributes: { "aria-label": diagnostic.message },
      }).range(diagnostic.from, diagnostic.to)), true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const evaluationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setEvaluationRange)) continue;
      const range = effect.value;
      value = range
        ? Decoration.set([Decoration.mark({
          class: "mix-evaluation",
          attributes: { "aria-label": "Currently evaluating this expression" },
        }).range(range.from, range.to)])
        : Decoration.none;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const identifierField = StateField.define<{ hover: number | null; decorations: DecorationSet }>({
  create: (state) => ({ hover: null, decorations: identifierDecorations(state, null) }),
  update(value, transaction) {
    let hover = transaction.selection !== undefined ? null : value.hover;
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredIdentifier)) hover = effect.value;
    }
    if (transaction.docChanged) hover = null;
    return {
      hover,
      decorations: transaction.docChanged || transaction.selection !== undefined ||
          transaction.effects.some((effect) => effect.is(setHoveredIdentifier))
        ? identifierDecorations(transaction.state, hover)
        : value.decorations.map(transaction.changes),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function identifierDecorations(state: EditorState, hover: number | null): DecorationSet {
  const tokens = identifierTokens(state.doc.toString());
  const position = hover ?? state.selection.main.head;
  const active = tokens.find((token) => position >= token.from && position <= token.to);
  if (!active || !tokens.some((token) => token.name === active.name && token.definition)) {
    return Decoration.none;
  }
  return Decoration.set(tokens
    .filter((token) => token.name === active.name)
    .map((token) => Decoration.mark({
      class: token.from === active.from
        ? "mix-identifier-focus"
        : token.definition
        ? "mix-identifier-definition"
        : "mix-identifier-usage",
    }).range(token.from, token.to)), true);
}

function identifierTokens(source: string): IdentifierToken[] {
  const tokens: IdentifierToken[] = [];
  let position = 0;
  let blockComment = false;
  while (position < source.length) {
    if (blockComment) {
      const end = source.indexOf("*/", position);
      if (end < 0) break;
      blockComment = false;
      position = end + 2;
      continue;
    }
    if (source.startsWith("/*", position)) {
      blockComment = true;
      position += 2;
      continue;
    }
    if (source[position] === "#") {
      const end = source.indexOf("\n", position);
      position = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[position] === '"') {
      position++;
      while (position < source.length) {
        if (source[position] === "\\" && position + 1 < source.length) position += 2;
        else if (source[position++] === '"') break;
      }
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_']*/.exec(source.slice(position));
    if (!match) {
      position++;
      continue;
    }
    const from = position;
    const to = position += match[0].length;
    let next = to;
    while (next < source.length && /\s/.test(source[next])) next++;
    tokens.push({
      from,
      to,
      name: match[0],
      definition: (source[next] === "=" && source[next + 1] !== "=") ||
        source[next] === ":",
    });
  }
  return tokens;
}

function loadProject(): Project {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "") as Project;
    if (saved.files.length && saved.files.some((file) => file.id === saved.activeId)) return saved;
  } catch { /* start with a clean project */ }
  const id = crypto.randomUUID();
  return { files: [{ id, name: "main.mix", contents: starter }], activeId: id, theme: "dark" };
}

function activeFile(): FileModel {
  return project.files.find((file) => file.id === project.activeId)!;
}

function extensions() {
  return [
    lineNumbers(), highlightActiveLineGutter(), history(), indentOnInput(),
    bracketMatching(), highlightActiveLine(), EditorView.lineWrapping, mixLanguage,
    search(), highlightSelectionMatches(),
    diagnosticField, evaluationField, identifierField, diagnosticTooltip,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const current = view.state.field(identifierField).hover;
        if (position !== current) view.dispatch({ effects: setHoveredIdentifier.of(position) });
      },
      mouseleave(_event, view) {
        if (view.state.field(identifierField).hover !== null) {
          view.dispatch({ effects: setHoveredIdentifier.of(null) });
        }
      },
    }),
    keymap.of([
      indentWithTab,
      { key: "Mod-/", run: toggleLineComment },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        activeFile().contents = update.state.doc.toString();
        stopLoop();
        projectRevision++;
        scheduleSave();
        scheduleCompile();
      }
      if (update.selectionSet || update.docChanged) updateCursor(update.view);
    }),
    ...(project.theme === "dark" ? [oneDark] : []),
  ];
}

const diagnosticTooltip = hoverTooltip((view, position) => {
  const diagnostic = (diagnosticsByFile.get(activeFile().name) ?? [])
    .find((candidate) => position >= candidate.from && position <= candidate.to);
  if (!diagnostic) return null;
  return {
    pos: diagnostic.from,
    end: diagnostic.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = `mix-diagnostic-tooltip ${diagnostic.level.toLowerCase()}`;
      const heading = document.createElement("div");
      heading.className = "mix-diagnostic-tooltip-heading";
      heading.textContent = diagnostic.level;
      const message = document.createElement("div");
      message.className = "mix-diagnostic-tooltip-message";
      message.textContent = diagnostic.message;
      dom.append(heading, message);
      return { dom };
    },
  };
});

function makeState(contents: string) {
  return EditorState.create({ doc: contents, extensions: extensions() });
}

function switchFile(id: string) {
  if (id === project.activeId) return;
  project.activeId = id;
  editor.setState(makeState(activeFile().contents));
  showActiveDiagnostics();
  renderTabs();
  scheduleSave();
  scheduleCompile();
  editor.focus();
}

function renderTabs() {
  tabList.replaceChildren(...project.files.map((file) => {
    const tab = document.createElement("button");
    tab.className = `tab${file.id === project.activeId ? " active" : ""}`;
    tab.type = "button";
    tab.role = "tab";
    tab.ariaSelected = String(file.id === project.activeId);
    tab.innerHTML = `<span class="file-dot"></span><span class="tab-name"></span><span class="close" title="Close file">×</span>`;
    tab.querySelector<HTMLElement>(".tab-name")!.textContent = file.name;
    tab.onclick = (event) => {
      if ((event.target as HTMLElement).classList.contains("close")) closeFile(file.id);
      else switchFile(file.id);
    };
    tab.ondblclick = () => renameFile(file.id);
    return tab;
  }));
  requestAnimationFrame(() => tabList.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
}

async function newFile() {
  const used = new Set(project.files.map((file) => file.name));
  let number = 1;
  while (used.has(`untitled-${number}.mix`)) number++;
  const name = await requestFileName({
    title: "Create a new file",
    description: "Add another source buffer to your mix project.",
    submitLabel: "Create file",
    initialName: `untitled-${number}.mix`,
  });
  if (!name) return;

  const file = { id: crypto.randomUUID(), name, contents: "" };
  project.files.push(file);
  project.activeId = file.id;
  editor.setState(makeState(""));
  projectRevision++;
  scheduleCompile();
  renderTabs();
  scheduleSave();
  editor.focus();
}

async function renameFile(id: string) {
  const file = project.files.find((candidate) => candidate.id === id)!;
  const name = await requestFileName({
    title: "Rename file",
    description: `Choose a new name for ${file.name}.`,
    submitLabel: "Rename file",
    initialName: file.name,
    excludeId: id,
  });
  if (!name || name === file.name) return;

  file.name = name;
  projectRevision++;
  scheduleCompile();
  renderTabs();
  scheduleSave();
  editor.focus();
}

type FileNameRequest = {
  title: string;
  description: string;
  submitLabel: string;
  initialName: string;
  excludeId?: string;
};

function requestFileName(request: FileNameRequest): Promise<string | null> {
  $("fileDialogTitle").textContent = request.title;
  $("fileDialogDescription").textContent = request.description;
  $("fileDialogSubmit").textContent = request.submitLabel;
  fileNameInput.value = request.initialName;
  fileNameInput.removeAttribute("aria-invalid");
  fileNameError.textContent = "";
  fileDialog.showModal();

  requestAnimationFrame(() => {
    fileNameInput.focus();
    const extension = request.initialName.lastIndexOf(".");
    fileNameInput.setSelectionRange(0, extension > 0 ? extension : request.initialName.length);
  });

  return new Promise((resolve) => {
    const finish = (value: string | null) => {
      fileDialogForm.removeEventListener("submit", submit);
      fileDialog.removeEventListener("cancel", cancel);
      $("fileDialogCancel").removeEventListener("click", cancel);
      fileDialog.removeEventListener("click", backdropClick);
      fileNameInput.removeEventListener("input", clearError);
      fileDialog.close();
      resolve(value);
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      finish(null);
    };
    const clearError = () => {
      fileNameInput.removeAttribute("aria-invalid");
      fileNameError.textContent = "";
    };
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      const name = fileNameInput.value.trim();
      let error = "";
      if (!name) error = "Enter a file name to continue.";
      else if (name === "." || name === "..") error = "That name is reserved.";
      else if (/[\\/]/.test(name)) error = "File names cannot contain slashes.";
      else if (project.files.some((file) => file.id !== request.excludeId && file.name === name)) {
        error = `A file named “${name}” is already open.`;
      }

      if (error) {
        fileNameInput.setAttribute("aria-invalid", "true");
        fileNameError.textContent = error;
        fileNameInput.focus();
        return;
      }
      finish(name);
    };
    const backdropClick = (event: MouseEvent) => {
      if (event.target === fileDialog) finish(null);
    };

    fileDialogForm.addEventListener("submit", submit);
    fileDialog.addEventListener("cancel", cancel);
    $("fileDialogCancel").addEventListener("click", cancel);
    fileDialog.addEventListener("click", backdropClick);
    fileNameInput.addEventListener("input", clearError);
  });
}

async function closeFile(id: string) {
  if (project.files.length === 1) return;
  const index = project.files.findIndex((file) => file.id === id);
  const file = project.files[index];
  if (file.contents.length > 0 && !await confirmFileDeletion(file.name)) return;

  project.files.splice(index, 1);
  if (project.activeId === id) {
    project.activeId = project.files[Math.min(index, project.files.length - 1)].id;
    editor.setState(makeState(activeFile().contents));
  }
  projectRevision++;
  scheduleCompile();
  renderTabs();
  scheduleSave();
}

function confirmFileDeletion(fileName: string): Promise<boolean> {
  $("deleteDialogDescription").textContent = `“${fileName}” will not be recoverable after it is deleted.`;
  deleteDialog.showModal();

  return new Promise((resolve) => {
    const finish = (confirmed: boolean) => {
      deleteDialogForm.removeEventListener("submit", submit);
      deleteDialog.removeEventListener("cancel", cancel);
      $("deleteDialogCancel").removeEventListener("click", cancel);
      deleteDialog.removeEventListener("click", backdropClick);
      deleteDialog.close();
      resolve(confirmed);
    };
    const submit = (event: SubmitEvent) => {
      event.preventDefault();
      finish(true);
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      finish(false);
    };
    const backdropClick = (event: MouseEvent) => {
      if (event.target === deleteDialog) finish(false);
    };

    deleteDialogForm.addEventListener("submit", submit);
    deleteDialog.addEventListener("cancel", cancel);
    $("deleteDialogCancel").addEventListener("click", cancel);
    deleteDialog.addEventListener("click", backdropClick);
  });
}

function scheduleSave() {
  saveState.textContent = "saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(storageKey, JSON.stringify(project));
    saveState.textContent = "saved locally";
  }, 250);
}

function scheduleCompile() {
  clearTimeout(compileTimer);
  const request = ++compileRequest;
  runStatus.textContent = "Checking…";
  runStatus.className = "run-status busy";
  compileTimer = setTimeout(() => {
    if (request === compileRequest) compileProject();
  }, 500);
}

function compileProject(): boolean {
  clearTimeout(compileTimer);
  const revision = projectRevision;
  const files = project.files.map(({ name, contents }) => ({ name, contents }));
  try {
    const result = JSON.parse(
      wasm.compile_project(JSON.stringify(files), activeFile().name),
    ) as CompileResult;
    diagnosticsByFile = collectDiagnostics(result);
    showActiveDiagnostics();
    compiledRevision = result.ok ? revision : -1;
    compiledEntry = result.ok ? activeFile().name : undefined;
    disassemblyText = result.ok ? result.disassembly : "No bytecode: compilation failed.";
    renderDisassembly();
    renderEvaluator();
    showEvaluationSource();
    $("debugProgramStatus").textContent = result.ok ? activeFile().name : "compile failed";
    runStatus.textContent = result.ok ? "No errors" : "Has errors";
    runStatus.className = `run-status ${result.ok ? "success" : "error"}`;
    if (!result.ok) renderTerminal(result.output || result.reports.message || "Compilation failed.");
    return result.ok;
  } catch (error) {
    diagnosticsByFile.clear();
    showActiveDiagnostics();
    compiledRevision = -1;
    compiledEntry = undefined;
    runStatus.textContent = "Check crashed";
    runStatus.className = "run-status error";
    console.error(error);
    return false;
  }
}

function collectDiagnostics(result: CompileResult): Map<string, EditorDiagnostic[]> {
  const diagnostics = new Map<string, EditorDiagnostic[]>();
  for (const report of result.reports.reports ?? []) {
    const annotations = report.annotations.length
      ? report.annotations
      : [{ kind: "Primary" as const, span: report.span, label: undefined }];
    for (const annotation of annotations) {
      const fileName = result.files[annotation.span.fid];
      const file = project.files.find((candidate) => candidate.name === fileName);
      if (!file) continue;
      let from = byteOffsetToCodeUnit(file.contents, annotation.span.range[0]);
      let to = byteOffsetToCodeUnit(file.contents, annotation.span.range[1]);
      if (to <= from) {
        if (from < file.contents.length) to = from + 1;
        else if (from > 0) from--;
      }
      const list = diagnostics.get(fileName) ?? [];
      list.push({
        from,
        to,
        level: report.level,
        message: annotation.label ? `${report.title}: ${annotation.label}` : report.title,
      });
      diagnostics.set(fileName, list);
    }
  }
  return diagnostics;
}

function byteOffsetToCodeUnit(source: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let units = 0;
  for (const character of source) {
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > byteOffset) break;
    bytes += width;
    units += character.length;
  }
  return units;
}

function showActiveDiagnostics() {
  const diagnostics = diagnosticsByFile.get(activeFile().name) ?? [];
  editor.dispatch({ effects: setDiagnostics.of(diagnostics) });
}

function runActive() {
  if (runnerMode.value === "canvas") {
    if (loopRunning) stopLoop();
    else startOrResumeLoop(false);
    return;
  }
  if (loopRunning) stopLoop();
  else startOrResumeEvaluation();
}

function loadSelectedExample() {
  const selected = exampleSelect.value;
  if (!selected) return;
  const interactive = selected === "interactive";
  const source = interactive ? canvasExample : simpleExample;
  stopLoop();
  activeFile().contents = source;
  editor.setState(makeState(source));
  projectRevision++;
  diagnosticsByFile.clear();
  showActiveDiagnostics();
  runnerMode.value = interactive ? "canvas" : "evaluate";
  updateRunnerMode();
  renderTabs();
  scheduleSave();
  compileProject();
  editor.focus();
  exampleSelect.value = "";
}

function initializeLoop(debug = false): boolean {
  if ((compiledRevision !== projectRevision || compiledEntry !== activeFile().name) && !compileProject()) {
    renderTerminal("Fix the highlighted compiler errors before starting the loop.");
    return false;
  }
  const started = JSON.parse(wasm.start_loop()) as RunResult;
  if (!started.ok) {
    renderTerminal(started.output);
    runStatus.textContent = "Loop failed";
    runStatus.className = "run-status error";
    return false;
  }
  loopInitialized = true;
  loopReady = false;
  loopFuel = 1_000;
  previousLoopState = undefined;
  currentFrameInput = undefined;
  loopFrameNumber = 0;
  pendingFrameComputeMs = 0;
  frameComputeSamples = [];
  renderFrameTimings();
  heldKeys.clear(); pressedKeys.clear(); releasedKeys.clear();
  currentFrameInput = undefined;
  if (debug) {
    renderDisassembly();
    renderEvaluator();
    showEvaluationSource();
  }
  return true;
}

function startOrResumeLoop(debug = false) {
  if (!loopInitialized && !initializeLoop(debug)) return;
  debugRunning = debug;
  loopRunning = true;
  setLoopView("canvas");
  if (debug) {
    renderDisassembly();
    renderEvaluator();
    showEvaluationSource();
  }
  $("runButton").innerHTML = "<span>■</span> Stop";
  runStatus.textContent = "Running loop";
  runStatus.className = "run-status success";
  updateDebugControls();
  // Run the first iteration synchronously so a canvas that was hidden by the
  // previous runner mode is laid out and painted during the initiating action.
  runnerCanvas.getBoundingClientRect();
  runnerCanvas.focus();
  runLoopFrame(true);
}

function initializeEvaluation(debug = false): boolean {
  if ((compiledRevision !== projectRevision || compiledEntry !== activeFile().name) && !compileProject()) {
    renderTerminal("Fix the highlighted compiler errors before starting evaluation.");
    return false;
  }
  const started = JSON.parse(wasm.start_evaluation(deepEval.checked)) as RunResult;
  if (!started.ok) {
    renderTerminal(started.output);
    runStatus.textContent = "Evaluation failed";
    runStatus.className = "run-status error";
    return false;
  }
  evaluationInitialized = true;
  evaluationFuel = 1_000;
  if (debug) {
    renderDisassembly();
    renderEvaluator();
    showEvaluationSource();
  }
  return true;
}

function startOrResumeEvaluation(debug = false) {
  if (!evaluationInitialized && !initializeEvaluation(debug)) return;
  debugRunning = debug;
  loopRunning = true;
  $("runButton").innerHTML = "<span>■</span> Stop";
  runStatus.textContent = "Evaluating…";
  runStatus.className = "run-status busy";
  updateDebugControls();
  runEvaluationBatch();
}

function runEvaluationBatch() {
  loopFrame = undefined;
  if (!loopRunning || runnerMode.value !== "evaluate") return;
  try {
    const startedAt = performance.now();
    const serialized = debugRunning
      ? wasm.step_evaluation(evaluationFuel)
      : wasm.run_evaluation(evaluationFuel);
    const result = JSON.parse(serialized) as FrameResult;
    evaluationFuel = adjustedFuel(evaluationFuel, performance.now() - startedAt);
    if (!result.ok) {
      failLoop(result.output, "Evaluation failed");
      return;
    }
    if (debugRunning) {
      renderDisassembly(result.instruction);
      renderEvaluator(result.evaluator);
      showEvaluationSource(result.source);
    }
    if (result.completed) {
      loopRunning = false;
      evaluationInitialized = false;
      renderTerminal(result.output || "(no output)");
      runStatus.textContent = "Finished";
      runStatus.className = "run-status success";
      $("runButton").innerHTML = "<span>▶</span> Run";
      updateDebugControls();
    } else {
      loopFrame = requestAnimationFrame(runEvaluationBatch);
    }
  } catch (error) {
    failLoop(String(error), "Evaluation crashed");
  }
}

function stopLoop() {
  const wasDebugRunning = debugRunning;
  if (loopFrame !== undefined) cancelAnimationFrame(loopFrame);
  loopFrame = undefined;
  loopRunning = false;
  debugRunning = false;
  loopInitialized = false;
  loopReady = false;
  evaluationInitialized = false;
  heldKeys.clear(); pressedKeys.clear(); releasedKeys.clear();
  $("runButton").innerHTML = "<span>▶</span> Run";
  if (wasDebugRunning) {
    renderDisassembly();
    renderEvaluator();
    showEvaluationSource();
  }
  updateDebugControls();
  runStatus.textContent = "Stopped";
  runStatus.className = "run-status";
}

function pauseLoop() {
  if (loopFrame !== undefined) cancelAnimationFrame(loopFrame);
  loopFrame = undefined;
  loopRunning = false;
  $("runButton").innerHTML = "<span>▶</span> Run";
  runStatus.textContent = loopInitialized || evaluationInitialized ? "Paused" : "Stopped";
  runStatus.className = "run-status";
  updateDebugControls();
}

function scheduleLoopFrame() {
  if (!loopRunning) return;
  loopFrame = requestAnimationFrame(() => runLoopFrame(true));
}

function stepLoop() {
  ensureCanvasMode();
  pauseLoop();
  if (!loopInitialized && !initializeLoop()) return;
  debugRunning = true;
  loopRunning = true;
  $("runButton").innerHTML = "<span>■</span> Stop";
  runStatus.textContent = "Stepping frame…";
  runLoopFrame(false);
  updateDebugControls();
}

function stepInstruction() {
  if (runnerMode.value === "evaluate") {
    stepEvaluationInstruction();
    return;
  }
  ensureCanvasMode();
  pauseLoop();
  if (!loopInitialized && !initializeLoop()) return;
  debugRunning = true;
  if (!loopReady) {
    try {
      const result = JSON.parse(wasm.step_loop_start(1)) as FrameResult;
      if (!result.ok) {
        failLoop(result.output, "Loop failed");
        return;
      }
      loopReady = result.completed;
      renderDisassembly(result.instruction);
      renderEvaluator(result.evaluator);
      showEvaluationSource(result.source);
      runStatus.textContent = loopReady
        ? "Loop initialized"
        : `Paused before instruction ${String(result.instruction).padStart(4, "0")}`;
      updateDebugControls();
    } catch (error) {
      failLoop(String(error), "Loop crashed");
    }
    return;
  }
  currentFrameInput ??= JSON.stringify(consumeLoopInput());
  try {
    const startedAt = performance.now();
    const serialized = wasm.step_instruction(currentFrameInput);
    pendingFrameComputeMs += performance.now() - startedAt;
    const result = JSON.parse(serialized) as FrameResult;
    if (result.completed) {
      currentFrameInput = undefined;
      completeFrameTiming();
    }
    if (!handleFrameResult(result)) return;
    renderDisassembly(result.instruction);
    renderEvaluator(result.evaluator);
    showEvaluationSource(result.source);
    runStatus.textContent = result.completed
      ? `Frame ${loopFrameNumber} completed`
      : `Paused before instruction ${String(result.instruction).padStart(4, "0")}`;
    updateDebugControls();
  } catch (error) {
    failLoop(String(error), "Loop crashed");
  }
}

function stepEvaluationInstruction() {
  pauseLoop();
  if (!evaluationInitialized && !initializeEvaluation()) return;
  try {
    const result = JSON.parse(wasm.step_evaluation(1)) as FrameResult;
    if (!result.ok) {
      failLoop(result.output, "Evaluation failed");
      return;
    }
    renderDisassembly(result.instruction);
    renderEvaluator(result.evaluator);
    showEvaluationSource(result.source);
    if (result.completed) {
      evaluationInitialized = false;
      renderTerminal(result.output || "(no output)");
      runStatus.textContent = "Evaluation finished";
      runStatus.className = "run-status success";
    } else {
      runStatus.textContent = `Paused before instruction ${String(result.instruction).padStart(4, "0")}`;
    }
    updateDebugControls();
  } catch (error) {
    failLoop(String(error), "Evaluation crashed");
  }
}

function consumeLoopInput() {
  const input = {
    keys: Object.fromEntries([...heldKeys].map((key) => [key, true])),
    pressed: [...pressedKeys],
    released: [...releasedKeys],
  };
  pressedKeys.clear();
  releasedKeys.clear();
  return input;
}

function runLoopFrame(scheduleNext: boolean) {
  loopFrame = undefined;
  if (scheduleNext && !loopRunning) return;
  try {
    if (!loopReady) {
      const startedAt = performance.now();
      const serialized = debugRunning
        ? wasm.step_loop_start(loopFuel)
        : wasm.run_loop_start(loopFuel);
      const result = JSON.parse(serialized) as FrameResult;
      loopFuel = adjustedFuel(loopFuel, performance.now() - startedAt);
      if (!result.ok) {
        failLoop(result.output, "Loop failed");
        return;
      }
      if (debugRunning) {
        renderDisassembly(result.instruction);
        renderEvaluator(result.evaluator);
        showEvaluationSource(result.source);
      }
      loopReady = result.completed;
      loopFrame = requestAnimationFrame(() => runLoopFrame(scheduleNext));
      return;
    }

    currentFrameInput ??= JSON.stringify(consumeLoopInput());
    const startedAt = performance.now();
    const serialized = wasm.run_frame(currentFrameInput, loopFuel);
    const elapsed = performance.now() - startedAt;
    loopFuel = adjustedFuel(loopFuel, elapsed);
    pendingFrameComputeMs += elapsed;
    const result = JSON.parse(serialized) as FrameResult;
    if (result.completed) {
      currentFrameInput = undefined;
      completeFrameTiming();
    }
    if (!handleFrameResult(result)) return;
    if (!scheduleNext) {
      renderDisassembly(result.instruction);
      renderEvaluator(result.evaluator);
      showEvaluationSource(result.source);
    }
    if (!result.completed) {
      loopFrame = requestAnimationFrame(() => runLoopFrame(scheduleNext));
    } else if (scheduleNext) {
      scheduleLoopFrame();
    } else {
      loopRunning = false;
      $("runButton").innerHTML = "<span>▶</span> Run";
      runStatus.textContent = `Paused at frame ${loopFrameNumber}`;
      updateDebugControls();
    }
  } catch (error) {
    failLoop(String(error), "Loop crashed");
  }
}

function adjustedFuel(current: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return Math.min(5_000_000, current * 2);
  }
  const ratio = Math.min(4, Math.max(0.25, targetBatchMs / elapsedMs));
  return Math.max(1, Math.min(5_000_000, Math.round(current * (0.75 + 0.25 * ratio))));
}

function handleFrameResult(result: FrameResult): boolean {
  if (!result.ok) {
    failLoop(result.output, "Loop failed");
    return false;
  }
  if (!result.completed) return true;
  previousLoopState = result.state;
  loopFrameNumber++;
  drawFrame(result.draw);
  if (loopView === "output") {
    renderTerminal(
      `Frame ${loopFrameNumber}\n\nState:\n${result.state ?? "undefined"}\n\nDraw:\n${JSON.stringify(result.draw, null, 2)}`,
    );
  }
  return true;
}

function failLoop(message: string, status: string) {
  renderTerminal(message);
  stopLoop();
  setLoopView("output");
  runStatus.textContent = status;
  runStatus.className = "run-status error";
  renderDisassembly();
}

function renderDisassembly(activeInstruction?: number) {
  disassembly.replaceChildren();
  const lines = disassemblyText.split("\n");
  for (const line of lines) {
    const row = document.createElement("span");
    row.className = "disassembly-line";
    row.textContent = `${line}\n`;
    if (activeInstruction !== undefined && line.match(/^  (\d{4})/)?.[1] === String(activeInstruction).padStart(4, "0")) {
      row.classList.add("active");
    }
    disassembly.append(row);
  }
  disassembly.querySelector(".active")?.scrollIntoView({ block: "center" });
}

function renderEvaluator(snapshot?: EvaluatorSnapshot) {
  $("evaluatorStatus").textContent = snapshot ? "instruction paused" : "not paused";
  renderStack("valueStack", "valueStackCount", snapshot?.values ?? []);
  renderStack("thunkStack", "thunkStackCount", snapshot?.thunks ?? []);
  renderStack("frameStack", "frameStackCount", snapshot?.frames ?? []);
}

function completeFrameTiming() {
  frameComputeSamples.push(pendingFrameComputeMs);
  if (frameComputeSamples.length > 60) frameComputeSamples.shift();
  pendingFrameComputeMs = 0;
  renderFrameTimings();
}

function renderFrameTimings() {
  const format = (value?: number) => value === undefined ? "—" : `${value.toFixed(value < 10 ? 2 : 1)} ms`;
  const current = frameComputeSamples.at(-1);
  const average = frameComputeSamples.length
    ? frameComputeSamples.reduce((sum, value) => sum + value, 0) / frameComputeSamples.length
    : undefined;
  $("frameTimeCurrent").textContent = format(current);
  $("frameTimeAverage").textContent = format(average);
  $("frameTimeMin").textContent = format(frameComputeSamples.length ? Math.min(...frameComputeSamples) : undefined);
  $("frameTimeMax").textContent = format(frameComputeSamples.length ? Math.max(...frameComputeSamples) : undefined);
}

function showEvaluationSource(source?: FrameResult["source"]) {
  if (!source || source.file !== activeFile().name) {
    editor.dispatch({ effects: setEvaluationRange.of(null) });
    return;
  }
  let from = byteOffsetToCodeUnit(activeFile().contents, source.range[0]);
  let to = byteOffsetToCodeUnit(activeFile().contents, source.range[1]);
  if (to <= from) {
    if (from < editor.state.doc.length) to = from + 1;
    else if (from > 0) from--;
  }
  editor.dispatch({
    effects: [
      setEvaluationRange.of({ from, to }),
      EditorView.scrollIntoView(from, { y: "center" }),
    ],
  });
}

function renderStack(listId: string, countId: string, entries: StackEntry[]) {
  $(countId).textContent = String(entries.length);
  const list = $(listId);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "stack-empty";
    empty.textContent = "empty";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...entries.map((entry, index) => {
    const details = document.createElement("details");
    details.className = "stack-entry";
    const summary = document.createElement("summary");
    const position = document.createElement("span");
    position.className = "stack-position";
    position.textContent = String(index);
    const label = document.createElement("span");
    label.className = "stack-summary";
    label.textContent = entry.summary;
    summary.append(position, label);
    const detail = document.createElement("pre");
    detail.textContent = entry.detail;
    details.append(summary, detail);
    return details;
  }));
}

function updateDebugControls() {
  ($<HTMLButtonElement>("debugStart")).disabled = loopRunning;
  ($<HTMLButtonElement>("debugPause")).disabled = !loopRunning;
  $("debugStart").classList.toggle("active", loopRunning);
}

function ensureCanvasMode() {
  if (runnerMode.value === "canvas") return;
  runnerMode.value = "canvas";
  updateRunnerMode();
}

function setLoopView(view: "canvas" | "output") {
  loopView = view;
  const showCanvas = view === "canvas";
  runnerCanvas.hidden = !showCanvas;
  output.hidden = showCanvas;
  $("canvasViewButton").classList.toggle("active", showCanvas);
  $("outputViewButton").classList.toggle("active", !showCanvas);
  if (showCanvas) runnerCanvas.focus();
  else if (loopRunning) {
    renderTerminal(
      `Frame ${loopFrameNumber}\n\nState:\n${previousLoopState ?? "undefined"}\n\nThe next frame will update this output.`,
    );
  }
}

function drawFrame(commands: DrawCommand[]) {
  const rect = runnerCanvas.getBoundingClientRect();
  const scale = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (runnerCanvas.width !== width || runnerCanvas.height !== height) {
    runnerCanvas.width = width; runnerCanvas.height = height;
  }
  const context = runnerCanvas.getContext("2d")!;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const number = (value: unknown, fallback = 0) => typeof value === "number" ? value : fallback;
  const color = (value: unknown, fallback = "#e8eaf0") => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const hsv = value as Record<string, unknown>;
      if (typeof hsv.h === "number" && typeof hsv.s === "number" && typeof hsv.v === "number") {
        const hue = ((hsv.h % 360) + 360) % 360;
        const saturation = Math.max(0, Math.min(1, hsv.s));
        const brightness = Math.max(0, Math.min(1, hsv.v));
        const chroma = brightness * saturation;
        const segment = hue / 60;
        const secondary = chroma * (1 - Math.abs(segment % 2 - 1));
        const [red, green, blue] = segment < 1 ? [chroma, secondary, 0]
          : segment < 2 ? [secondary, chroma, 0]
          : segment < 3 ? [0, chroma, secondary]
          : segment < 4 ? [0, secondary, chroma]
          : segment < 5 ? [secondary, 0, chroma]
          : [chroma, 0, secondary];
        const minimum = brightness - chroma;
        return `rgb(${Math.round((red + minimum) * 255)} ${Math.round((green + minimum) * 255)} ${Math.round((blue + minimum) * 255)})`;
      }
    }
    return fallback;
  };
  for (const command of commands ?? []) {
    const kind = command.kind ?? command.type;
    context.fillStyle = color(command.color ?? command.fill);
    context.strokeStyle = color(command.color ?? command.stroke);
    context.lineWidth = number(command.lineWidth ?? command.width, 1);
    if (kind === "clear") {
      context.fillStyle = color(command.color, "#0b0d10");
      context.fillRect(0, 0, rect.width, rect.height);
    } else if (kind === "rect") {
      context.fillRect(number(command.x), number(command.y), number(command.width), number(command.height));
    } else if (kind === "circle") {
      context.beginPath();
      context.arc(number(command.x), number(command.y), number(command.radius), 0, Math.PI * 2);
      context.fill();
    } else if (kind === "line") {
      context.beginPath(); context.moveTo(number(command.x1), number(command.y1));
      context.lineTo(number(command.x2), number(command.y2)); context.stroke();
    } else if (kind === "text") {
      context.font = `${number(command.size, 16)}px ui-monospace, monospace`;
      context.textAlign = command.align === "center" || command.align === "right" ? command.align : "left";
      context.fillText(String(command.text ?? ""), number(command.x), number(command.y));
    }
  }
}

type AnsiStyle = {
  bold: boolean;
  dim: boolean;
  foreground?: number;
  background?: number;
};

function renderTerminal(text: string) {
  output.replaceChildren();
  const style: AnsiStyle = { bold: false, dim: false };
  const pattern = /\x1b\[([0-9;]*)m/g;
  let offset = 0;

  const append = (value: string) => {
    if (!value) return;
    const names = project.files
      .map((file) => file.name)
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|");
    const locations = new RegExp(
      `(${names}):(\\d+):(\\d+)(?:-(?:(\\d+)\\.)?(\\d+))?`,
      "g",
    );
    let textOffset = 0;

    const appendPart = (part: string, location?: RegExpMatchArray) => {
      if (!part) return;
      const element = document.createElement(location ? "a" : "span");
      element.textContent = part;
      if (style.bold) element.classList.add("ansi-bold");
      if (style.dim) element.classList.add("ansi-dim");
      if (style.foreground !== undefined) element.classList.add(`ansi-fg-${style.foreground}`);
      if (style.background !== undefined) element.classList.add(`ansi-bg-${style.background}`);

      if (location) {
        const link = element as HTMLAnchorElement;
        link.classList.add("source-link");
        link.href = `#${encodeURIComponent(location[0])}`;
        link.title = `Open ${location[0]}`;
        link.onclick = (event) => {
          event.preventDefault();
          openSourceLocation({
            fileName: location[1],
            startLine: Number(location[2]),
            startColumn: Number(location[3]),
            endLine: location[4] ? Number(location[4]) : undefined,
            endColumn: location[5] ? Number(location[5]) : undefined,
          });
        };
      }
      output.appendChild(element);
    };

    for (const location of value.matchAll(locations)) {
      appendPart(value.slice(textOffset, location.index));
      appendPart(location[0], location);
      textOffset = location.index + location[0].length;
    }
    appendPart(value.slice(textOffset));
  };

  for (const match of text.matchAll(pattern)) {
    append(text.slice(offset, match.index));
    const codes = (match[1] || "0").split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        style.bold = false;
        style.dim = false;
        style.foreground = undefined;
        style.background = undefined;
      } else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) { style.bold = false; style.dim = false; }
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.foreground = code;
      else if (code === 39) style.foreground = undefined;
      else if (code >= 40 && code <= 47) style.background = code;
      else if (code === 49) style.background = undefined;
    }
    offset = match.index + match[0].length;
  }
  append(text.slice(offset));
}

type SourceLocation = {
  fileName: string;
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openSourceLocation(location: SourceLocation) {
  const file = project.files.find((candidate) => candidate.name === location.fileName);
  if (!file) return;
  if (file.id !== project.activeId) switchFile(file.id);

  const position = (lineNumber: number, columnNumber: number, inclusiveEnd = false) => {
    const safeLineNumber = Math.max(1, Math.min(lineNumber, editor.state.doc.lines));
    const line = editor.state.doc.line(safeLineNumber);
    const columnOffset = inclusiveEnd ? columnNumber : columnNumber - 1;
    return line.from + Math.max(0, Math.min(columnOffset, line.length));
  };

  const anchor = position(location.startLine, location.startColumn);
  const head = location.endColumn === undefined
    ? anchor
    : position(location.endLine ?? location.startLine, location.endColumn, true);

  editor.dispatch({
    selection: { anchor, head },
    effects: EditorView.scrollIntoView(anchor, { y: "center" }),
  });
  editor.focus();
}

function updateCursor(view: EditorView) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  cursorStatus.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}

function applyTheme() {
  document.documentElement.dataset.theme = project.theme;
  if (editor) {
    editor.setState(makeState(activeFile().contents));
    showActiveDiagnostics();
  }
  $("themeButton").textContent = project.theme === "dark" ? "☾" : "☀";
}

function setupSplitter() {
  const splitter = $("splitter");
  const workspace = splitter.parentElement!;
  splitter.onpointerdown = (down) => {
    splitter.setPointerCapture(down.pointerId);
    splitter.onpointermove = (move) => {
      const rect = workspace.getBoundingClientRect();
      const percent = Math.min(78, Math.max(30, ((move.clientY - rect.top) / rect.height) * 100));
      workspace.style.setProperty("--editor-height", `${percent}%`);
    };
    splitter.onpointerup = () => { splitter.onpointermove = null; };
  };
}

function setupDebugPanel() {
  const splitter = $("debugSplitter");
  const toggle = $("debugToggle");
  splitter.onpointerdown = (down) => {
    splitter.setPointerCapture(down.pointerId);
    splitter.onpointermove = (move) => {
      const rect = workbench.getBoundingClientRect();
      const width = Math.min(rect.width * .62, Math.max(260, rect.right - move.clientX));
      workbench.style.setProperty("--debug-width", `${width}px`);
    };
    splitter.onpointerup = () => { splitter.onpointermove = null; };
  };
  toggle.onclick = () => {
    const collapsed = workbench.classList.toggle("debug-collapsed");
    toggle.textContent = collapsed ? "‹" : "›";
    toggle.title = collapsed ? "Expand debugger" : "Minimize debugger";
    toggle.setAttribute("aria-label", toggle.title);
  };
}

function updateRunnerMode() {
  stopLoop();
  const canvasMode = runnerMode.value === "canvas";
  runnerViewSwitch.hidden = !canvasMode;
  if (canvasMode) setLoopView("canvas");
  else {
    runnerCanvas.hidden = true;
    output.hidden = false;
  }
  $("deepEvalLabel").hidden = canvasMode;
  document.querySelectorAll<HTMLElement>(".canvas-debug-only")
    .forEach((element) => element.hidden = !canvasMode);
  runStatus.textContent = "Ready";
  updateDebugControls();
}

editor = new EditorView({ state: makeState(activeFile().contents), parent: $("editor") });
renderTabs();
applyTheme();
setupSplitter();
setupDebugPanel();
updateCursor(editor);

$("newFileButton").onclick = newFile;
exampleSelect.onchange = loadSelectedExample;
$("runButton").onclick = runActive;
$("clearButton").onclick = () => { output.textContent = ""; runStatus.textContent = "Ready"; runStatus.className = "run-status"; };
$("themeButton").onclick = () => { project.theme = project.theme === "dark" ? "light" : "dark"; applyTheme(); scheduleSave(); };
runnerMode.onchange = updateRunnerMode;
$("debugStart").onclick = () => {
  if (runnerMode.value === "canvas") startOrResumeLoop(true);
  else startOrResumeEvaluation(true);
};
$("debugPause").onclick = pauseLoop;
$("debugStepInstruction").onclick = stepInstruction;
$("debugStepFrame").onclick = stepLoop;
$("canvasViewButton").onclick = () => setLoopView("canvas");
$("outputViewButton").onclick = () => setLoopView("output");
globalThis.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.repeat && !fileDialog.open && !deleteDialog.open) {
    event.preventDefault();
    event.stopPropagation();
    runActive();
  } else if (loopRunning && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!heldKeys.has(event.key)) pressedKeys.add(event.key);
    heldKeys.add(event.key);
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  }
});
globalThis.addEventListener("keyup", (event) => {
  if (!loopRunning) return;
  heldKeys.delete(event.key);
  releasedKeys.add(event.key);
});
$("loading").remove();
$("app").hidden = false;
editor.focus();
updateRunnerMode();
scheduleCompile();
