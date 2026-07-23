use std::{borrow::Cow, cell::RefCell, collections::HashMap, path::Path};

use mix::{
    bytecode::PrettyProgram,
    files::FileLoader,
    runtime::{
        Runtime,
        eval::{Evaluator, FrameKind, PotentialFrame},
        lazy::LazyValue,
        pretty::{PrettyLazyValue, PrettyValue},
        scope::ScopeBuilder,
        thunk::ThunkSnapshot,
        value::{AttrSet, List, StringKind, Value},
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
    entry: LazyValue,
    loop_function: Option<Value>,
    loop_state: Option<Value>,
    frame_evaluator: Option<Evaluator>,
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
    let mut runtime = Runtime::new(loader, ScopeBuilder::new().bottom());
    match runtime.load(entry) {
        Ok(entry) => {
            let disassembly = PrettyProgram::new(&runtime.program, &runtime.loader).to_string();
            SESSION.with(|slot| {
                *slot.borrow_mut() = Some(Session {
                    runtime,
                    entry,
                    loop_function: None,
                    loop_state: None,
                    frame_evaluator: None,
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

#[wasm_bindgen]
pub fn run_compiled(deep: bool) -> String {
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_run_failure("compile the project before running it");
        };
        let evaluated = if deep {
            session.runtime.deep_eval(session.entry.clone())
        } else {
            session.runtime.eval(session.entry.clone())
        };
        match evaluated {
            Ok(value) => serde_json::to_string(&RunResult {
                ok: true,
                output: PrettyValue::new(&session.runtime, &value).to_string(),
            })
            .unwrap(),
            Err(trace) => json_run_failure(trace.render(&session.runtime)),
        }
    })
}

/// Resolve the retained entry to a loop function and reset its in-memory state.
#[wasm_bindgen]
pub fn start_loop() -> String {
    SESSION.with(|slot| {
        let mut session = slot.borrow_mut();
        let Some(session) = session.as_mut() else {
            return json_run_failure("compile the project before starting the loop");
        };
        let value = match session.runtime.eval(session.entry.clone()) {
            Ok(value) => value,
            Err(trace) => return json_run_failure(trace.render(&session.runtime)),
        };
        let function = match value {
            Value::Lambda(_) => value,
            Value::AttrSet(attrs) => {
                let Some(main) = attrs.get("main") else {
                    return json_run_failure(
                        "loop runner expected a lambda or an attribute set with `main`",
                    );
                };
                match session.runtime.eval(main.clone()) {
                    Ok(value @ Value::Lambda(_)) => value,
                    Ok(value) => return json_run_failure(format!("`main` is {}", value.ty())),
                    Err(trace) => return json_run_failure(trace.render(&session.runtime)),
                }
            }
            value => {
                return json_run_failure(format!(
                    "loop runner expected a lambda or an attribute set with `main`, got {}",
                    value.ty()
                ));
            }
        };
        session.loop_function = Some(function);
        session.loop_state = None;
        session.frame_evaluator = None;
        serde_json::to_string(&RunResult {
            ok: true,
            output: String::new(),
        })
        .unwrap()
    })
}

/// Run one frame using retained Mix values. State never crosses the Wasm boundary.
#[wasm_bindgen]
pub fn run_frame(input_json: &str) -> String {
    run_frame_inner(input_json, None)
}

/// Execute exactly one bytecode instruction in the current canvas frame.
#[wasm_bindgen]
pub fn step_instruction(input_json: &str) -> String {
    run_frame_inner(input_json, Some(1))
}

fn run_frame_inner(input_json: &str, instruction_limit: Option<usize>) -> String {
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
            session.frame_evaluator = Some(
                match Evaluator::begin_call(&session.runtime, function, LazyValue::from(args), true)
                {
                    Ok(evaluator) => evaluator,
                    Err(trace) => return json_frame_failure(trace.render(&session.runtime)),
                },
            );
        }

        let evaluator = session.frame_evaluator.as_mut().unwrap();
        let value = match instruction_limit {
            Some(limit) => match evaluator.run_for(&session.runtime, limit) {
                Ok(Some(value)) => value,
                Ok(None) => {
                    return serde_json::to_string(&FrameResult {
                        ok: true,
                        output: String::new(),
                        state: session
                            .loop_state
                            .as_ref()
                            .map(|state| PrettyValue::new(&session.runtime, state).to_string()),
                        draw: serde_json::Value::Array(vec![]),
                        completed: false,
                        instruction: Some(evaluator.curr_frame.pos.index()),
                        evaluator: Some(snapshot_evaluator(&session.runtime, evaluator)),
                        source: Some(source_position(
                            &session.runtime,
                            evaluator.curr_frame.pos.index(),
                        )),
                    })
                    .unwrap();
                }
                Err(trace) => return json_frame_failure(trace.render(&session.runtime)),
            },
            None => match evaluator.run(&session.runtime) {
                Ok(value) => value,
                Err(trace) => return json_frame_failure(trace.render(&session.runtime)),
            },
        };
        session.frame_evaluator = None;
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
            Ok(value) => value,
            Err(_) => return json_frame_failure("loop runner returned unevaluated `state`"),
        };
        let draw = match draw.try_get_value() {
            Ok(value) => value_to_json(&value, 0),
            Err(_) => return json_frame_failure("loop runner returned unevaluated `draw`"),
        };
        let state_preview = PrettyValue::new(&session.runtime, &state).to_string();
        session.loop_state = Some(state);
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
        .value_stack
        .iter()
        .rev()
        .map(|value| {
            let rendered = PrettyValue::new(runtime, value).to_string();
            StackEntry {
                summary: format!("{} · {}", value.ty(), short(&rendered)),
                detail: rendered,
            }
        })
        .collect();
    let thunks = evaluator
        .thunk_stack
        .iter()
        .rev()
        .map(|lazy| match lazy.try_get_value() {
            Ok(value) => {
                let rendered = PrettyValue::new(runtime, &value).to_string();
                StackEntry {
                    summary: format!("evaluated · {} · {}", value.ty(), short(&rendered)),
                    detail: rendered,
                }
            }
            Err(thunk) => {
                let (state, detail) = match thunk.snapshot() {
                    Some(ThunkSnapshot::Constructing(pos)) => (
                        format!("constructing @{:04}", pos.index()),
                        format!("state: constructing\nposition: {:04}", pos.index()),
                    ),
                    Some(ThunkSnapshot::Unevaluated(pos)) => (
                        format!("unevaluated @{:04}", pos.index()),
                        format!("state: unevaluated\nposition: {:04}", pos.index()),
                    ),
                    Some(ThunkSnapshot::Evaluating) => {
                        ("evaluating".into(), "state: evaluating".into())
                    }
                    Some(ThunkSnapshot::Evaluated(value)) => {
                        let rendered = PrettyValue::new(runtime, &value).to_string();
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

    let mut frames = vec![frame_entry(
        "current",
        evaluator.curr_frame.pos.index(),
        &evaluator.curr_frame.kind,
        format!("{:?}", evaluator.curr_frame.scope),
    )];
    frames.extend(evaluator.frame_stack.iter().rev().map(|frame| match frame {
        PotentialFrame::Realized(frame) => frame_entry(
            "suspended",
            frame.pos.index(),
            &frame.kind,
            format!("{:?}", frame.scope),
        ),
        PotentialFrame::DeepEval(pos) => StackEntry {
            summary: format!("deep eval · @{:04}", pos.index()),
            detail: format!("kind: deep eval\nposition: {:04}", pos.index()),
        },
        PotentialFrame::PotentialDeep(lazy) => StackEntry {
            summary: format!(
                "potential deep · {}",
                short(&PrettyLazyValue::new(runtime, lazy).to_string())
            ),
            detail: format!(
                "kind: potential deep\nvalue:\n{}",
                PrettyLazyValue::new(runtime, lazy)
            ),
        },
    }));
    EvaluatorSnapshot {
        values,
        thunks,
        frames,
    }
}

fn source_position(runtime: &Runtime, position: usize) -> SourcePosition {
    let span = runtime
        .program
        .find_pos(mix::bytecode::CodePos::from_index(position));
    let (path, _) = runtime.loader.file(span.fid);
    SourcePosition {
        file: path.display().to_string(),
        range: (span.range.start, span.range.end),
    }
}

fn frame_entry(label: &str, pos: usize, kind: &FrameKind, scope: String) -> StackEntry {
    StackEntry {
        summary: format!("{label} · {} · @{pos:04}", frame_kind_name(kind)),
        detail: format!("kind: {kind:?}\nposition: {pos:04}\nscope: {scope}"),
    }
}

fn frame_kind_name(kind: &FrameKind) -> &'static str {
    match kind {
        FrameKind::Function => "function",
        FrameKind::FunctionDeepRoot => "function deep root",
        FrameKind::ThunkEval(_) => "thunk eval",
        FrameKind::ThunkEvalDeep(_) => "thunk eval deep",
        FrameKind::ThunkEvalDeepRoot(_) => "thunk eval deep root",
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
            .map(|value| {
                value
                    .try_get_value()
                    .map(|value| value_to_json(&value, depth + 1))
                    .unwrap_or_default()
            })
            .collect(),
        Value::AttrSet(values) => values
            .iter()
            .map(|(key, value)| {
                (
                    (&**key).to_owned(),
                    value
                        .try_get_value()
                        .map(|value| value_to_json(&value, depth + 1))
                        .unwrap_or_default(),
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

    #[test]
    fn compiled_entry_is_reused_for_evaluation() {
        let compiled =
            compile_project_inner(r#"[{"name":"main.mix","contents":"6 * 7"}]"#, "main.mix");
        assert!(compiled.ok);

        let result: RunResult = serde_json::from_str(&run_compiled(true)).unwrap();
        assert!(result.ok, "{}", result.output);
        assert_eq!(result.output, "42");
    }

    #[test]
    fn loop_state_stays_as_a_mix_value_between_frames() {
        let source = r#"[{"name":"main.mix","contents":"args: { state = if args.input.first then 1 else args.state + 1; draw = []; }"}]"#;
        assert!(compile_project_inner(source, "main.mix").ok);
        let started: RunResult = serde_json::from_str(&start_loop()).unwrap();
        assert!(started.ok, "{}", started.output);

        let first: FrameResult =
            serde_json::from_str(&run_frame(r#"{"keys":{},"pressed":[],"released":[]}"#)).unwrap();
        let second: FrameResult =
            serde_json::from_str(&run_frame(r#"{"keys":{},"pressed":[],"released":[]}"#)).unwrap();
        assert!(first.ok, "{}", first.output);
        assert!(second.ok, "{}", second.output);
        assert_eq!(first.state.as_deref(), Some("1"));
        assert_eq!(second.state.as_deref(), Some("2"));
    }

    #[test]
    fn instruction_step_pauses_a_partially_evaluated_frame() {
        let source = r#"[{"name":"main.mix","contents":"args: { state = 1 + 2; draw = []; }"}]"#;
        assert!(compile_project_inner(source, "main.mix").ok);
        let started: RunResult = serde_json::from_str(&start_loop()).unwrap();
        assert!(started.ok, "{}", started.output);

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

        let completed: FrameResult =
            serde_json::from_str(&run_frame(r#"{"keys":{},"pressed":[],"released":[]}"#)).unwrap();
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
