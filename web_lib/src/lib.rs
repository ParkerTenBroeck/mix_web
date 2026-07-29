use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{HashMap, HashSet},
    path::Path,
};

use mix::{
    bytecode::{CodePos, PrettyProgram},
    files::FileLoader,
    runtime::{
        Runtime,
        eval::{Evaluator, FrameKind, Fule, NativePosKind},
        lazy::{LazyValue, LazyValueKind},
        pretty::{PrettyLazyValue, PrettyValue},
        scope::{Scope, ScopeBuilder},
        thunk::Thunk,
        thunk::ThunkSnapshot,
        trace::ErrorTrace,
        value::{AttrSet, Lambda, List, StringKind, Value},
    },
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct SourceFile {
    name: String,
    contents: String,
}

#[derive(Serialize)]
struct CompileResult {
    ok: bool,
    output: String,
    disassembly: String,
    reports: serde_json::Value,
    files: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct RunResult {
    ok: bool,
    output: String,
}

#[derive(Deserialize)]
struct FrameInput {
    keys: HashMap<String, bool>,
    pressed: Vec<String>,
    released: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct FrameResult {
    ok: bool,
    output: String,
    state: Option<String>,
    draw: serde_json::Value,
    completed: bool,
    instruction: Option<usize>,
    evaluator: Option<EvaluatorSnapshot>,
    source: Option<SourcePosition>,
}

#[derive(Serialize, Deserialize)]
struct SourcePosition {
    file: String,
    range: (usize, usize),
}

#[derive(Serialize, Deserialize)]
struct EvaluatorSnapshot {
    values: Vec<StackEntry>,
    thunks: Vec<StackEntry>,
    frames: Vec<StackEntry>,
}

#[derive(Serialize, Deserialize)]
struct StackEntry {
    summary: String,
    detail: String,
}

struct Session {
    runtime: Runtime,
    entry_position: CodePos,
    top_scope: Scope,
    loop_function: Option<Lambda>,
    loop_setup_evaluator: Option<Evaluator>,
    loop_setup_is_main: bool,
    loop_state: Option<Value>,
    frame_evaluator: Option<Evaluator>,
    evaluation_evaluator: Option<Evaluator>,
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Compile the project once and retain its runtime and entry value for later calls.
#[wasm_bindgen]
pub fn compile_project(project_json: &str, entry: &str) -> String {
    let result = compile_project_inner(project_json, entry);
    serde_json::to_string(&result).expect("CompileResult is serializable")
}

fn compile_project_inner(project_json: &str, entry: &str) -> CompileResult {
    let source_files: Vec<SourceFile> = match serde_json::from_str(project_json) {
        Ok(files) => files,
        Err(error) => return compile_failure(format!("invalid project data: {error}")),
    };
    let file_names = source_files
        .iter()
        .map(|file| file.name.clone())
        .collect::<Vec<_>>();
    let sources: HashMap<_, _> = source_files
        .into_iter()
        .map(|file| (file.name, file.contents))
        .collect();
    if !sources.contains_key(entry) {
        return compile_failure(format!("entry file `{entry}` does not exist"));
    }

    let loader = in_memory_loader(sources);
    // Preload in project order so serialized FileId values map to `file_names`.
    for name in &file_names {
        let _ = loader.load(Path::new(name));
    }
    let top_scope = ScopeBuilder::new()
        .with("false", false)
        .with("true", true)
        .with_builtins()
        .bottom();
    let mut runtime = Runtime::new(loader, top_scope.clone());
    match runtime.load(entry) {
        Ok(entry) => {
            let entry_position = match entry.try_get_value() {
                LazyValueKind::Thunk(thunk) => match thunk.snapshot() {
                    Some(ThunkSnapshot::Expr(position)) => position,
                    _ => return compile_failure("compiled entry is not unevaluated".into()),
                },
                LazyValueKind::Value(_) => {
                    return compile_failure("compiled entry was evaluated unexpectedly".into());
                }
            };
            let disassembly = PrettyProgram::new(&runtime.program, &runtime.loader).to_string();
            SESSION.with(|slot| {
                *slot.borrow_mut() = Some(Session {
                    runtime,
                    entry_position,
                    top_scope,
                    loop_function: None,
                    loop_setup_evaluator: None,
                    loop_setup_is_main: false,
                    loop_state: None,
                    frame_evaluator: None,
                    evaluation_evaluator: None,
                });
            });
            CompileResult {
                ok: true,
                output: String::new(),
                disassembly,
                reports: serde_json::json!({ "reports": [] }),
                files: file_names,
            }
        }
        Err(reports) => {
            SESSION.with(|slot| *slot.borrow_mut() = None);
            let output = reports.render(&runtime.loader.files()).join("\n\n");
            CompileResult {
                ok: false,
                output,
                disassembly: String::new(),
                reports: serde_json::to_value(reports).expect("Reports is serializable"),
                files: file_names,
            }
        }
    }
}

/// Start a fresh, resumable evaluation of the compiled top-level expression.
#[wasm_bindgen]
pub fn start_evaluation(deep: bool) -> String {
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_run_failure("compile the project before starting evaluation");
        };
        let lazy = LazyValue::uneval(session.entry_position, session.top_scope.clone());
        session.evaluation_evaluator = match Evaluator::begin_eval(&mut session.runtime, lazy, deep)
        {
            Ok(evaluator) => Some(evaluator),
            Err(trace) => return json_run_failure(trace.render(&session.runtime)),
        };
        serde_json::to_string(&RunResult {
            ok: true,
            output: String::new(),
        })
        .unwrap()
    })
}

/// Advance top-level evaluation by at most `instructions` bytecode operations.
#[wasm_bindgen]
pub fn step_evaluation(instructions: usize) -> String {
    run_evaluation_inner(instructions, true)
}

/// Run a bounded top-level slice without collecting debugger state.
#[wasm_bindgen]
pub fn run_evaluation(instructions: usize) -> String {
    run_evaluation_inner(instructions, false)
}

fn run_evaluation_inner(instructions: usize, debug: bool) -> String {
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_frame_failure("compile the project before stepping evaluation");
        };
        let Session {
            runtime,
            evaluation_evaluator,
            ..
        } = session;
        let Some(evaluator) = evaluation_evaluator.as_mut() else {
            return json_frame_failure("start evaluation before stepping it");
        };
        match evaluator.run(runtime, Fule::limited(instructions.max(1))) {
            Ok(Some(value)) => {
                *evaluation_evaluator = None;
                serde_json::to_string(&FrameResult {
                    ok: true,
                    output: render_web_value(runtime, &value),
                    state: None,
                    draw: serde_json::Value::Array(vec![]),
                    completed: true,
                    instruction: None,
                    evaluator: None,
                    source: None,
                })
                .unwrap()
            }
            Ok(None) => pending_result(runtime, evaluator, None, debug),
            Err(error) => {
                json_frame_failure(ErrorTrace::build(runtime, evaluator, error).render(runtime))
            }
        }
    })
}

/// Begin resolving the retained entry to a loop function without blocking.
#[wasm_bindgen]
pub fn start_loop() -> String {
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_run_failure("compile the project before starting the loop");
        };
        let entry = LazyValue::uneval(session.entry_position, session.top_scope.clone());
        session.loop_setup_evaluator =
            match Evaluator::begin_eval(&mut session.runtime, entry, false) {
                Ok(evaluator) => Some(evaluator),
                Err(trace) => return json_run_failure(trace.render(&session.runtime)),
            };
        session.loop_setup_is_main = false;
        session.loop_function = None;
        session.loop_state = None;
        session.frame_evaluator = None;
        serde_json::to_string(&RunResult {
            ok: true,
            output: String::new(),
        })
        .unwrap()
    })
}

/// Advance loop initialization by a bounded number of instructions.
#[wasm_bindgen]
pub fn step_loop_start(instructions: usize) -> String {
    run_loop_start_inner(instructions, true)
}

/// Run a bounded loop-initialization slice without collecting debugger state.
#[wasm_bindgen]
pub fn run_loop_start(instructions: usize) -> String {
    run_loop_start_inner(instructions, false)
}

fn run_loop_start_inner(instructions: usize, debug: bool) -> String {
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_frame_failure("compile the project before starting the loop");
        };
        let Session {
            runtime,
            loop_setup_evaluator,
            loop_setup_is_main,
            loop_function,
            ..
        } = session;
        let Some(evaluator) = loop_setup_evaluator.as_mut() else {
            return json_frame_failure("start the loop before advancing initialization");
        };
        let value = match evaluator.run(runtime, Fule::limited(instructions.max(1))) {
            Ok(Some(value)) => value,
            Ok(None) => return pending_result(runtime, evaluator, None, debug),
            Err(error) => {
                return json_frame_failure(
                    ErrorTrace::build(runtime, evaluator, error).render(runtime),
                );
            }
        };

        if *loop_setup_is_main {
            let Value::Lambda(lambda) = value else {
                return json_frame_failure(format!("`main` is {}", value.ty()));
            };
            *loop_function = Some(lambda);
            *loop_setup_evaluator = None;
            return completed_frame_result();
        }

        match value {
            Value::Lambda(lambda) => {
                *loop_function = Some(lambda);
                *loop_setup_evaluator = None;
                completed_frame_result()
            }
            Value::AttrSet(attrs) => {
                let Some(main) = attrs.get("main") else {
                    return json_frame_failure(
                        "loop runner expected a lambda or an attribute set with `main`",
                    );
                };
                *loop_setup_evaluator = match Evaluator::begin_eval(runtime, main.clone(), false) {
                    Ok(evaluator) => Some(evaluator),
                    Err(trace) => return json_frame_failure(trace.render(runtime)),
                };
                *loop_setup_is_main = true;
                serde_json::to_string(&FrameResult {
                    ok: true,
                    output: String::new(),
                    state: None,
                    draw: serde_json::Value::Array(vec![]),
                    completed: false,
                    instruction: None,
                    evaluator: None,
                    source: None,
                })
                .unwrap()
            }
            value => json_frame_failure(format!(
                "loop runner expected a lambda or an attribute set with `main`, got {}",
                value.ty()
            )),
        }
    })
}

fn completed_frame_result() -> String {
    serde_json::to_string(&FrameResult {
        ok: true,
        output: String::new(),
        state: None,
        draw: serde_json::Value::Array(vec![]),
        completed: true,
        instruction: None,
        evaluator: None,
        source: None,
    })
    .unwrap()
}

fn pending_result(
    runtime: &Runtime,
    evaluator: &Evaluator,
    state: Option<String>,
    debug: bool,
) -> String {
    let position = debug.then(|| evaluator_position(evaluator)).flatten();
    serde_json::to_string(&FrameResult {
        ok: true,
        output: String::new(),
        state,
        draw: serde_json::Value::Array(vec![]),
        completed: false,
        instruction: position.map(CodePos::index),
        evaluator: debug.then(|| snapshot_evaluator(runtime, evaluator)),
        source: position.and_then(|position| source_position(runtime, position.index())),
    })
    .unwrap()
}

/// Run a bounded slice of one frame. State never crosses the Wasm boundary.
#[wasm_bindgen]
pub fn run_frame(input_json: &str, instructions: usize) -> String {
    run_frame_inner(input_json, instructions.max(1), false)
}

/// Execute exactly one bytecode instruction in the current canvas frame.
#[wasm_bindgen]
pub fn step_instruction(input_json: &str) -> String {
    run_frame_inner(input_json, 1, true)
}

fn run_frame_inner(input_json: &str, instruction_limit: usize, debug: bool) -> String {
    let input: FrameInput = match serde_json::from_str(input_json) {
        Ok(input) => input,
        Err(error) => return json_frame_failure(format!("invalid frame input: {error}")),
    };
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_frame_failure("compile the project before running a frame");
        };
        if session.frame_evaluator.is_none() {
            let Some(function) = session.loop_function.clone() else {
                return json_frame_failure("start the loop before running a frame");
            };
            let first = session.loop_state.is_none();
            let args = frame_args(input, first, session.loop_state.clone());
            let application = LazyValue::from(Thunk::application(function, LazyValue::from(args)));
            session.frame_evaluator = Some(
                match Evaluator::begin_eval(&mut session.runtime, application, true) {
                    Ok(evaluator) => evaluator,
                    Err(trace) => return json_frame_failure(trace.render(&session.runtime)),
                },
            );
        }

        let Session {
            runtime,
            frame_evaluator,
            loop_state,
            ..
        } = session;
        let evaluator = frame_evaluator.as_mut().unwrap();
        let value = match evaluator.run(runtime, Fule::limited(instruction_limit)) {
            Ok(Some(value)) => value,
            Ok(None) => {
                let state = loop_state
                    .as_ref()
                    .map(|state| render_web_value(runtime, state));
                return pending_result(runtime, evaluator, state, debug);
            }
            Err(error) => {
                return json_frame_failure(
                    ErrorTrace::build(runtime, evaluator, error).render(runtime),
                );
            }
        };
        *frame_evaluator = None;
        let Value::AttrSet(result) = value else {
            return json_frame_failure(
                "loop runner must return an attribute set with `state` and `draw`",
            );
        };
        let Some(state) = result.get("state") else {
            return json_frame_failure("loop runner result is missing `state`");
        };
        let Some(draw) = result.get("draw") else {
            return json_frame_failure("loop runner result is missing `draw`");
        };
        let state = match state.try_get_value() {
            LazyValueKind::Value(value) => value,
            LazyValueKind::Thunk(_) => {
                return json_frame_failure("loop runner returned unevaluated `state`");
            }
        };
        let draw = match draw.try_get_value() {
            LazyValueKind::Value(value) => value_to_json(&value, 0),
            LazyValueKind::Thunk(_) => {
                return json_frame_failure("loop runner returned unevaluated `draw`");
            }
        };
        let state_preview = render_web_value(runtime, &state);
        *loop_state = Some(state);
        serde_json::to_string(&FrameResult {
            ok: true,
            output: String::new(),
            state: Some(state_preview),
            draw,
            completed: true,
            instruction: None,
            evaluator: None,
            source: None,
        })
        .unwrap()
    })
}

fn frame_args(input: FrameInput, first: bool, state: Option<Value>) -> Value {
    let mut input_value = AttrSet::new();
    input_value
        .get_mut()
        .insert(string("first"), LazyValue::from(first));

    let mut keys = AttrSet::new();
    for (key, value) in input.keys {
        keys.get_mut().insert(string(key), LazyValue::from(value));
    }
    input_value
        .get_mut()
        .insert(string("keys"), LazyValue::from(Value::AttrSet(keys)));
    input_value.get_mut().insert(
        string("pressed"),
        LazyValue::from(Value::List(string_list(input.pressed))),
    );
    input_value.get_mut().insert(
        string("released"),
        LazyValue::from(Value::List(string_list(input.released))),
    );

    let mut args = AttrSet::new();
    args.get_mut().insert(
        string("input"),
        LazyValue::from(Value::AttrSet(input_value)),
    );
    if let Some(state) = state {
        args.get_mut()
            .insert(string("state"), LazyValue::from(state));
    }
    Value::AttrSet(args)
}

fn snapshot_evaluator(runtime: &Runtime, evaluator: &Evaluator) -> EvaluatorSnapshot {
    let values = evaluator
        .local
        .value_stack
        .iter()
        .rev()
        .map(|value| {
            let rendered = render_web_value(runtime, value);
            StackEntry {
                summary: format!("{} · {}", value.ty(), short(&rendered)),
                detail: rendered,
            }
        })
        .collect();
    let thunks = evaluator
        .local
        .lazy_stack
        .iter()
        .rev()
        .map(|lazy| match lazy.try_get_value() {
            LazyValueKind::Value(value) => {
                let rendered = render_web_value(runtime, &value);
                StackEntry {
                    summary: format!("evaluated · {} · {}", value.ty(), short(&rendered)),
                    detail: rendered,
                }
            }
            LazyValueKind::Thunk(thunk) => {
                let (state, detail) = match thunk.snapshot() {
                    Some(ThunkSnapshot::Constructing(pos)) => (
                        format!("constructing @{:04}", pos.index()),
                        format!("state: constructing\nposition: {:04}", pos.index()),
                    ),
                    Some(ThunkSnapshot::Expr(pos)) => (
                        format!("unevaluated @{:04}", pos.index()),
                        format!("state: unevaluated\nposition: {:04}", pos.index()),
                    ),
                    Some(ThunkSnapshot::Apply(func, arg)) => (
                        "application · lambda".into(),
                        format!(
                            "state: application\nfunction: {}\nargument: {}",
                            render_web_lambda(runtime, &func),
                            PrettyLazyValue::new(runtime, &arg),
                        ),
                    ),
                    Some(ThunkSnapshot::Evaluating) => {
                        ("evaluating".into(), "state: evaluating".into())
                    }
                    Some(ThunkSnapshot::Evaluated(value)) => {
                        let rendered = render_web_value(runtime, &value);
                        (
                            format!("evaluated · {} · {}", value.ty(), short(&rendered)),
                            rendered,
                        )
                    }
                    None => ("borrowed".into(), "state is currently borrowed".into()),
                };
                StackEntry {
                    summary: state,
                    detail: format!(
                        "{detail}\n\nvalue:\n{}",
                        PrettyLazyValue::new(runtime, lazy)
                    ),
                }
            }
        })
        .collect();

    let frames = evaluator
        .frames
        .iter()
        .rev()
        .enumerate()
        .map(|(index, frame)| {
            let label = if index == 0 { "current" } else { "suspended" };
            match &frame.kind {
                FrameKind::ByteCode(bytecode) => StackEntry {
                    summary: format!("{label} · bytecode · @{:04}", bytecode.pos.index()),
                    detail: format!(
                        "kind: bytecode\nposition: {:04}\ndeep: {}\nthunk: {}\nscope: {:?}",
                        bytecode.pos.index(),
                        frame.deep,
                        frame.thunk.is_some(),
                        bytecode.scope,
                    ),
                },
                FrameKind::Native(native) => StackEntry {
                    summary: format!("{label} · native · {}", native.name),
                    detail: format!(
                        "kind: native\nidentifier: {}\nposition: {}\ndeep: {}\nthunk: {}",
                        native.name,
                        native_position(native.pos)
                            .map(|position| format!("{:04}", position.index()))
                            .unwrap_or_else(|| "none".into()),
                        frame.deep,
                        frame.thunk.is_some(),
                    ),
                },
            }
        })
        .collect();
    EvaluatorSnapshot {
        values,
        thunks,
        frames,
    }
}

fn source_position(runtime: &Runtime, position: usize) -> Option<SourcePosition> {
    let span = runtime
        .program
        .find_pos(mix::bytecode::CodePos::from_index(position))?;
    let (path, _) = runtime.loader.file(span.fid);
    Some(SourcePosition {
        file: path.display().to_string(),
        range: (span.range.start, span.range.end),
    })
}

fn evaluator_position(evaluator: &Evaluator) -> Option<CodePos> {
    match &evaluator.frames.last()?.kind {
        FrameKind::ByteCode(frame) => Some(frame.pos),
        FrameKind::Native(frame) => native_position(frame.pos),
    }
}

fn native_position(position: NativePosKind) -> Option<CodePos> {
    match position {
        NativePosKind::Value(position) | NativePosKind::Expr(position) => Some(position),
        NativePosKind::None => None,
    }
}

fn short(value: &str) -> String {
    let single_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= 54 {
        single_line
    } else {
        format!("{}…", single_line.chars().take(53).collect::<String>())
    }
}

fn string_list(values: Vec<String>) -> List {
    let mut list = List::with_capacity(values.len());
    list.get_mut().extend(
        values
            .into_iter()
            .map(|value| LazyValue::from(Value::from(value))),
    );
    list
}

fn string(value: impl Into<String>) -> StringKind {
    // Bytecode identifiers are interned. Use the same StringKind variant so
    // attribute lookup can compare host-created parameter keys directly.
    StringKind::Interned(std::rc::Rc::new(value.into()))
}

fn in_memory_loader(sources: HashMap<String, String>) -> FileLoader {
    FileLoader::new(move |path: &Path| {
        let name = path.to_string_lossy();
        sources
            .get(name.as_ref())
            .cloned()
            .map(std::rc::Rc::new)
            .ok_or_else(|| Cow::Owned(format!("file `{name}` was not found in this project")))
    })
}

fn render_web_value(runtime: &Runtime, value: &Value) -> String {
    render_web_value_inner(runtime, value, 0, &mut HashSet::new())
}

fn render_web_lambda(runtime: &Runtime, lambda: &Lambda) -> String {
    render_web_value(runtime, &Value::Lambda(lambda.clone()))
}

fn render_web_value_inner(
    runtime: &Runtime,
    value: &Value,
    indent: usize,
    active: &mut HashSet<(u8, usize)>,
) -> String {
    match value {
        Value::Bool(value) => value.to_string(),
        Value::Int(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::String(value) => format!("{:?}", &**value),
        Value::Path(value) => value.display().to_string(),
        Value::Lambda(Lambda::NativeLambda(lambda)) => {
            format!("<<builtin {}>>", lambda.identifier())
        }
        Value::Lambda(_) => PrettyValue::new(runtime, value).to_string(),
        Value::List(values) => {
            let key = (0, values.id());
            if !active.insert(key) {
                return "<<recursive list>>".into();
            }
            let rendered = if values.is_empty() {
                "[ ]".into()
            } else {
                let mut output = String::from("[\n");
                for lazy in values.iter() {
                    output.push_str(&"  ".repeat(indent + 1));
                    output.push_str(&render_web_lazy(runtime, lazy, indent + 1, active));
                    output.push_str(",\n");
                }
                output.push_str(&"  ".repeat(indent));
                output.push(']');
                output
            };
            active.remove(&key);
            rendered
        }
        Value::AttrSet(values) => {
            let key = (1, values.id());
            if !active.insert(key) {
                return "<<recursive attrset>>".into();
            }
            let rendered = if values.is_empty() {
                "{ }".into()
            } else {
                let mut entries = values.iter().collect::<Vec<_>>();
                entries.sort_by(|(left, _), (right, _)| left.cmp(right));
                let mut output = String::from("{\n");
                for (name, lazy) in entries {
                    output.push_str(&"  ".repeat(indent + 1));
                    output.push_str(&render_attr_name(name));
                    output.push_str(" = ");
                    output.push_str(&render_web_lazy(runtime, lazy, indent + 1, active));
                    output.push_str(";\n");
                }
                output.push_str(&"  ".repeat(indent));
                output.push('}');
                output
            };
            active.remove(&key);
            rendered
        }
    }
}

fn render_web_lazy(
    runtime: &Runtime,
    lazy: &LazyValue,
    indent: usize,
    active: &mut HashSet<(u8, usize)>,
) -> String {
    match lazy.try_get_value() {
        LazyValueKind::Value(value) => render_web_value_inner(runtime, &value, indent, active),
        LazyValueKind::Thunk(_) => PrettyLazyValue::new(runtime, lazy).to_string(),
    }
}

fn render_attr_name(name: &str) -> String {
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
    if valid_start
        && chars.all(|character| {
            character == '_' || character == '\'' || character.is_ascii_alphanumeric()
        })
    {
        name.into()
    } else {
        serde_json::to_string(name).unwrap()
    }
}

fn value_to_json(value: &Value, depth: usize) -> serde_json::Value {
    if depth > 32 {
        return serde_json::Value::Null;
    }
    match value {
        Value::Bool(value) => (*value).into(),
        Value::Int(value) => (*value).into(),
        Value::Float(value) => (*value).into(),
        Value::String(value) => (&**value).into(),
        Value::Path(value) => value.display().to_string().into(),
        Value::List(values) => values
            .iter()
            .map(|value| match value.try_get_value() {
                LazyValueKind::Value(value) => value_to_json(&value, depth + 1),
                LazyValueKind::Thunk(_) => serde_json::Value::Null,
            })
            .collect(),
        Value::AttrSet(values) => values
            .iter()
            .map(|(key, value)| {
                (
                    (&**key).to_owned(),
                    match value.try_get_value() {
                        LazyValueKind::Value(value) => value_to_json(&value, depth + 1),
                        LazyValueKind::Thunk(_) => serde_json::Value::Null,
                    },
                )
            })
            .collect(),
        Value::Lambda(_) => serde_json::Value::Null,
    }
}

fn compile_failure(message: String) -> CompileResult {
    SESSION.with(|slot| *slot.borrow_mut() = None);
    CompileResult {
        ok: false,
        output: message.clone(),
        disassembly: String::new(),
        reports: serde_json::json!({ "reports": [], "message": message }),
        files: vec![],
    }
}

fn json_run_failure(message: impl Into<String>) -> String {
    serde_json::to_string(&RunResult {
        ok: false,
        output: message.into(),
    })
    .unwrap()
}

fn json_frame_failure(message: impl Into<String>) -> String {
    serde_json::to_string(&FrameResult {
        ok: false,
        output: message.into(),
        state: None,
        draw: serde_json::Value::Array(vec![]),
        completed: false,
        instruction: None,
        evaluator: None,
        source: None,
    })
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finish_evaluation(deep: bool) -> FrameResult {
        let started: RunResult = serde_json::from_str(&start_evaluation(deep)).unwrap();
        assert!(started.ok, "{}", started.output);
        loop {
            let result: FrameResult = serde_json::from_str(&step_evaluation(100)).unwrap();
            assert!(result.ok, "{}", result.output);
            if result.completed {
                return result;
            }
        }
    }

    fn finish_loop_start() {
        let started: RunResult = serde_json::from_str(&start_loop()).unwrap();
        assert!(started.ok, "{}", started.output);
        loop {
            let result: FrameResult = serde_json::from_str(&step_loop_start(100)).unwrap();
            assert!(result.ok, "{}", result.output);
            if result.completed {
                return;
            }
        }
    }

    fn finish_frame(input: &str) -> FrameResult {
        loop {
            let result: FrameResult = serde_json::from_str(&run_frame(input, 100)).unwrap();
            assert!(result.ok, "{}", result.output);
            if result.completed {
                return result;
            }
        }
    }

    #[test]
    fn compiled_entry_is_reused_for_evaluation() {
        let compiled =
            compile_project_inner(r#"[{"name":"main.mix","contents":"6 * 7"}]"#, "main.mix");
        assert!(compiled.ok);

        let result = finish_evaluation(true);
        assert_eq!(result.output, "42");
    }

    #[test]
    fn native_builtins_render_without_panicking() {
        let source = r#"[{"name":"main.mix","contents":"{ res = builtins.mkList; }"}]"#;
        assert!(compile_project_inner(source, "main.mix").ok);
        let result = finish_evaluation(true);
        assert!(result.output.contains("res = <<builtin mkList>>"));
    }

    #[test]
    fn top_level_evaluation_can_be_instruction_stepped() {
        assert!(
            compile_project_inner(
                r#"[{"name":"main.mix","contents":"{ greeting = \"hello\"; answer = (6 * 7) + 1; }"}]"#,
                "main.mix",
            )
            .ok
        );
        let started: RunResult = serde_json::from_str(&start_evaluation(true)).unwrap();
        assert!(started.ok, "{}", started.output);

        let first: FrameResult = serde_json::from_str(&step_evaluation(1)).unwrap();
        assert!(first.ok, "{}", first.output);
        assert!(!first.completed);
        assert!(first.evaluator.is_some());
        assert!(first.source.is_some());

        let finished: FrameResult = serde_json::from_str(&step_evaluation(100)).unwrap();
        assert!(finished.ok, "{}", finished.output);
        assert!(finished.completed);
        assert!(finished.output.contains("answer = 43"));
        assert!(finished.output.contains("greeting = \"hello\""));
    }

    #[test]
    fn loop_state_stays_as_a_mix_value_between_frames() {
        let source = r#"[{"name":"main.mix","contents":"args: { state = if args.input.first then 1 else args.state + 1; draw = []; }"}]"#;
        assert!(compile_project_inner(source, "main.mix").ok);
        finish_loop_start();

        let first = finish_frame(r#"{"keys":{},"pressed":[],"released":[]}"#);
        let second = finish_frame(r#"{"keys":{},"pressed":[],"released":[]}"#);
        assert!(first.ok, "{}", first.output);
        assert!(second.ok, "{}", second.output);
        assert_eq!(first.state.as_deref(), Some("1"));
        assert_eq!(second.state.as_deref(), Some("2"));
    }

    #[test]
    fn instruction_step_pauses_a_partially_evaluated_frame() {
        let source = r#"[{"name":"main.mix","contents":"args: { state = 1 + 2; draw = []; }"}]"#;
        assert!(compile_project_inner(source, "main.mix").ok);
        finish_loop_start();

        let stepped: FrameResult = serde_json::from_str(&step_instruction(
            r#"{"keys":{},"pressed":[],"released":[]}"#,
        ))
        .unwrap();
        assert!(stepped.ok, "{}", stepped.output);
        assert!(!stepped.completed);
        assert!(stepped.instruction.is_some());
        let snapshot = stepped.evaluator.expect("instruction step has a snapshot");
        assert!(!snapshot.frames.is_empty());
        let source = stepped.source.expect("instruction step has a source span");
        assert_eq!(source.file, "main.mix");
        assert!(source.range.1 >= source.range.0);

        let completed = finish_frame(r#"{"keys":{},"pressed":[],"released":[]}"#);
        assert!(completed.completed);
        assert_eq!(completed.state.as_deref(), Some("3"));
    }

    #[test]
    fn compiler_reports_are_returned_as_structured_json() {
        let result = compile_project_inner(r#"[{"name":"main.mix","contents":"{"}]"#, "main.mix");
        assert!(!result.ok);
        assert!(
            result.reports["reports"]
                .as_array()
                .is_some_and(|reports| !reports.is_empty())
        );
    }
}
